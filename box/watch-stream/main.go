// watch-stream: makes library files playable in a web browser.
//
// The Watch Worker asks for a session (POST /start) with a short-lived signed URL of the source file. ffmpeg reads it
// (HTTP range requests through the Worker, so this box needs no HostBRR credentials) and writes an HLS stream
// (fragmented MP4) into a session folder, copying the video when the browser can decode it and converting what it
// can't: audio to AAC stereo, old video (Xvid, MPEG-2, or HEVC for browsers without it) to H.264. The browser plays
// while ffmpeg works; copying a 2-hour film takes a minute or two, converting old SD video ~10-20 minutes.
//
// Listens on 127.0.0.1 only; Caddy puts it behind the download box's basic auth at /__watchstream/.
// Sessions idle for 10 minutes are stopped and deleted; at most -max sessions; refuses when disk is short.
//
// It also downloads YouTube videos into the library (/yt/*, see yt.go).
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	listen  = flag.String("listen", "127.0.0.1:8891", "address to listen on")
	dir     = flag.String("dir", "/var/tmp/watch-stream", "session folders")
	ffmpeg  = flag.String("ffmpeg", "ffmpeg", "ffmpeg binary (looked up on PATH unless absolute)")
	maxSess = flag.Int("max", 3, "max concurrent sessions")
	minFree = flag.Int64("min-free-gb", 15, "refuse new sessions below this much free disk (GB)")
	idle    = flag.Duration("idle", 10*time.Minute, "stop sessions not read for this long")
	srcHost = flag.String("src-host", "", "the Worker's host (e.g. watch.example.com); sources are only read from it (required for playback)")
	threads = flag.Int("threads", 3, "ffmpeg threads for video conversion (leave a core for downloads)")
)

type session struct {
	ID       string    `json:"id"`
	File     string    `json:"file"`
	Video    string    `json:"video"`
	Audio    string    `json:"audio"`
	Started  time.Time `json:"started"`
	Duration float64   `json:"duration"` // seconds, from the Worker (probe)
	Done     float64   `json:"done"`     // seconds written by ffmpeg
	Finished bool      `json:"finished"`
	Error    string    `json:"error,omitempty"`
	last     time.Time
	cmd      *exec.Cmd
}

var (
	mu       sync.Mutex
	sessions = map[string]*session{}
	idRe     = regexp.MustCompile(`^[0-9a-f]{32}$`)
	nameRe   = regexp.MustCompile(`^(index\.m3u8|init\.mp4|seg\d{5}\.m4s)$`)
)

func freeGB() int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(*dir, &st); err != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize) / 1e9
}

func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func stop(s *session, remove bool) {
	if s.cmd != nil && s.cmd.Process != nil && !s.Finished {
		s.cmd.Process.Kill()
	}
	if remove {
		os.RemoveAll(filepath.Join(*dir, s.ID))
	}
}

func handleStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonOut(w, 405, map[string]string{"error": "POST only"})
		return
	}
	var req struct {
		Src      string  `json:"src"`
		File     string  `json:"file"`
		Video    string  `json:"video"` // copy | h264
		Audio    string  `json:"audio"` // copy | aac
		Hevc     bool    `json:"hevc"`  // copied video is HEVC (needs the hvc1 tag for Safari)
		Duration float64 `json:"duration"`
		Size     int64   `json:"size"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		jsonOut(w, 400, map[string]string{"error": "bad json"})
		return
	}
	u, err := url.Parse(req.Src)
	if *srcHost == "" {
		jsonOut(w, 503, map[string]string{"error": "watch-stream is not configured (-src-host)"})
		return
	}
	if err != nil || u.Scheme != "https" || u.Host != *srcHost {
		jsonOut(w, 400, map[string]string{"error": "source must be on " + *srcHost})
		return
	}
	if req.Video != "copy" && req.Video != "h264" || req.Audio != "copy" && req.Audio != "aac" {
		jsonOut(w, 400, map[string]string{"error": "video must be copy|h264, audio copy|aac"})
		return
	}
	need := int64(*minFree)
	if req.Video == "copy" {
		need += req.Size / 1e9 // a copied stream takes about the file's size
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sessions) >= *maxSess {
		// Make room by dropping the least recently read session.
		var oldest *session
		for _, s := range sessions {
			if oldest == nil || s.last.Before(oldest.last) {
				oldest = s
			}
		}
		if time.Since(oldest.last) < 2*time.Minute {
			jsonOut(w, 503, map[string]string{"error": fmt.Sprintf("%d videos are already playing in browsers; try again later", len(sessions))})
			return
		}
		stop(oldest, true)
		delete(sessions, oldest.ID)
	}
	if free := freeGB(); free < need {
		jsonOut(w, 507, map[string]string{"error": fmt.Sprintf("not enough disk on the download box (%d GB free, %d GB needed)", free, need)})
		return
	}
	b := make([]byte, 16)
	rand.Read(b)
	s := &session{ID: hex.EncodeToString(b), File: req.File, Video: req.Video, Audio: req.Audio, Started: time.Now(), last: time.Now(), Duration: req.Duration}
	out := filepath.Join(*dir, s.ID)
	if err := os.MkdirAll(out, 0o700); err != nil {
		jsonOut(w, 500, map[string]string{"error": err.Error()})
		return
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
		"-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10",
		"-user_agent", "watch-stream", "-i", req.Src, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"}
	if req.Video == "copy" {
		args = append(args, "-c:v", "copy")
		if req.Hevc {
			args = append(args, "-tag:v", "hvc1")
		}
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
			"-vf", "scale='min(1920,iw)':-2", "-threads", strconv.Itoa(*threads), "-force_key_frames", "expr:gte(t,n_forced*6)")
	}
	if req.Audio == "copy" {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-ac", "2", "-b:a", "192k")
	}
	args = append(args, "-f", "hls", "-hls_time", "6", "-hls_list_size", "0", "-hls_playlist_type", "event",
		"-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", filepath.Join(out, "seg%05d.m4s"),
		"-hls_flags", "independent_segments+temp_file", filepath.Join(out, "index.m3u8"))
	cmd := exec.Command(*ffmpeg, args...)
	cmd.Dir = out
	stdout, _ := cmd.StdoutPipe()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		os.RemoveAll(out)
		jsonOut(w, 500, map[string]string{"error": "ffmpeg: " + err.Error()})
		return
	}
	s.cmd = cmd
	sessions[s.ID] = s
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "out_time_us="); ok {
				if us, err := strconv.ParseFloat(v, 64); err == nil {
					mu.Lock()
					s.Done = us / 1e6
					mu.Unlock()
				}
			}
		}
		err := cmd.Wait()
		mu.Lock()
		s.Finished = true
		if err != nil && s.Error == "" {
			msg := strings.TrimSpace(stderr.String())
			if len(msg) > 300 {
				msg = msg[len(msg)-300:]
			}
			s.Error = "ffmpeg stopped: " + msg
		}
		mu.Unlock()
		log.Printf("session %s (%s) finished in %s err=%v", s.ID, s.File, time.Since(s.Started).Round(time.Second), err)
	}()
	log.Printf("session %s started: %s video=%s audio=%s", s.ID, s.File, s.Video, s.Audio)
	jsonOut(w, 200, s)
}

// /s/<id>/<file> serves stream files; /s/<id> (GET) is the status; /s/<id>/stop stops it.
func handleSession(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/s/"), "/")
	if !idRe.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	mu.Lock()
	s := sessions[parts[0]]
	if s != nil {
		s.last = time.Now()
	}
	mu.Unlock()
	if s == nil {
		jsonOut(w, 404, map[string]string{"error": "session ended"})
		return
	}
	if len(parts) == 1 {
		mu.Lock()
		defer mu.Unlock()
		jsonOut(w, 200, s)
		return
	}
	if parts[1] == "stop" {
		mu.Lock()
		stop(s, true)
		delete(sessions, s.ID)
		mu.Unlock()
		jsonOut(w, 200, map[string]bool{"ok": true})
		return
	}
	if len(parts) != 2 || !nameRe.MatchString(parts[1]) {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(*dir, s.ID, parts[1])
	// The playlist and first segments appear a few seconds after start: wait briefly instead of failing.
	for i := 0; i < 40; i++ {
		if _, err := os.Stat(p); err == nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if strings.HasSuffix(p, ".m3u8") {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Cache-Control", "private, max-age=3600")
	}
	http.ServeFile(w, r, p)
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	list := []*session{}
	for _, s := range sessions {
		list = append(list, s)
	}
	jsonOut(w, 200, map[string]any{"sessions": list, "free_gb": freeGB(), "max": *maxSess})
}

func reaper() {
	for range time.Tick(30 * time.Second) {
		mu.Lock()
		for id, s := range sessions {
			low := !s.Finished && freeGB() < 5
			if time.Since(s.last) > *idle || low {
				if low {
					s.Error = "stopped: download box disk almost full"
				}
				stop(s, true)
				delete(sessions, id)
				log.Printf("session %s removed (idle or low disk)", id)
			}
		}
		mu.Unlock()
	}
}

func main() {
	flag.Parse()
	os.MkdirAll(*dir, 0o700)
	// Leftovers from before a restart are useless (their ffmpeg is gone).
	if entries, err := os.ReadDir(*dir); err == nil {
		for _, e := range entries {
			if idRe.MatchString(e.Name()) {
				os.RemoveAll(filepath.Join(*dir, e.Name()))
			}
		}
	}
	go reaper()
	ytLoad()
	go ytRunner()
	mux := http.NewServeMux()
	mux.HandleFunc("/start", handleStart)
	mux.HandleFunc("/s/", handleSession)
	mux.HandleFunc("/status", handleStatus)
	mux.HandleFunc("/yt/", handleYT)
	log.Printf("watch-stream on %s, sessions in %s", *listen, *dir)
	log.Fatal(http.ListenAndServe(*listen, mux))
}
