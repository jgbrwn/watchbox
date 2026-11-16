// YouTube downloads for the Watch library.
//
// The Worker asks for a video by id (POST /yt/add). One job runs at a time: yt-dlp downloads it into a work folder
// (no cookies: it tries player clients that YouTube still serves to datacenter IPs, and updates itself when YouTube
// changes), this program names the files "<channel>/<title> [<id>].<ext>", writes a small metadata sidecar
// (.info.json), the thumbnail (.jpg) and a poster-shaped version (.poster.jpg), English subtitles (.en.srt), then
// rsyncs them to HostBRR media/youtube/ (sidecars first, the video last, so the library never sees a video without
// its metadata), deletes the work folder and tells the Worker (/hooks/youtube, signed like the qBittorrent hook).
// The Worker also polls GET /yt/jobs, so a missed hook only delays things.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ytDir     = flag.String("yt-dir", "/var/tmp/watch-yt", "YouTube work folders and the job list")
	ytdlpBin  = flag.String("ytdlp", filepath.Join(os.Getenv("HOME"), ".yt-dlp/bin/yt-dlp"), "yt-dlp (in a venv, so it can update itself with pip)")
	ytDest    = flag.String("yt-dest", "", "rsync destination of the YouTube library folder, e.g. storage:media/youtube/ (required for YouTube)")
	ytTVDest  = flag.String("yt-tv-dest", "", "rsync destination of the TV library folder, for playlists saved as episodes")
	ytClients = flag.String("yt-clients", "web_embedded,web_safari;default;android", "YouTube player_client sets to try, in order, separated by ;")
	ytMinFree = flag.Int64("yt-min-free-gb", 20, "don't start a download below this much free disk (GB)")
	ytProxy   = flag.String("yt-proxy", "", "proxy for yt-dlp (e.g. socks5://127.0.0.1:1080, the yt_proxy SSH tunnel through HostBRR)")
	ytJS      = flag.String("yt-js-runtime", "deno", "JavaScript runtime yt-dlp uses for YouTube (deno or node)")
	ytExtra   = flag.String("yt-extra", "", "extra yt-dlp arguments, space-separated (e.g. --proxy socks5://127.0.0.1:1080, or --cookies /path)")
	hookEnv   = flag.String("hook-env", filepath.Join(os.Getenv("HOME"), ".config/watch-hook.env"), "WATCH_HOOK_URL and WATCH_HOOK_SECRET (shared with watch-torrent-done)")
)

type ytJob struct {
	ID       string    `json:"id"`
	Quality  string    `json:"quality"`
	Status   string    `json:"status"` // queued | downloading | processing | uploading | done | failed
	Progress float64   `json:"progress"`
	Title    string    `json:"title,omitempty"`
	Channel  string    `json:"channel,omitempty"`
	Dest     string    `json:"dest,omitempty"` // youtube (default) | tv
	Name     string    `json:"name,omitempty"` // tv: "<Show>/Season 01/<Show> - S01E02 - <title> [<id>]" (no extension)
	Path     string    `json:"path,omitempty"` // under media/youtube/ or media/tvshows/
	Size     int64     `json:"size,omitempty"`
	Error    string    `json:"error,omitempty"`
	Client   string    `json:"client,omitempty"` // player clients that worked
	Added    time.Time `json:"added"`
	Updated  time.Time `json:"updated"`
	cancel   context.CancelFunc
}

var (
	ytMu   sync.Mutex
	ytJobs = map[string]*ytJob{}
	ytWake = make(chan struct{}, 1)
	ytIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	pctRe  = regexp.MustCompile(`^PROG\s+([\d.]+)%`)
)

var qualities = map[string][]string{
	// H.264 + AAC first: plays everywhere (TV apps, every browser) without conversion.
	"720":  {"-f", "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b"},
	"1080": {"-f", "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b"},
	// Above 1080p YouTube only has VP9/AV1. Prefer VP9 (hardware-decoded by more TV boxes than AV1).
	"2160": {"-f", "bv*[height<=2160]+ba/b", "-S", "res:2160,vcodec:vp9,acodec:aac"},
}

func ytSave() {
	list := make([]*ytJob, 0, len(ytJobs))
	for _, j := range ytJobs {
		list = append(list, j)
	}
	b, _ := json.MarshalIndent(list, "", " ")
	tmp := filepath.Join(*ytDir, "jobs.json.tmp")
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, filepath.Join(*ytDir, "jobs.json"))
	}
}

func ytLoad() {
	os.MkdirAll(*ytDir, 0o700)
	b, err := os.ReadFile(filepath.Join(*ytDir, "jobs.json"))
	if err == nil {
		var list []*ytJob
		json.Unmarshal(b, &list)
		for _, j := range list {
			if j.Status != "done" && j.Status != "failed" {
				j.Status, j.Progress = "queued", 0 // interrupted by a restart: start again
			}
			ytJobs[j.ID] = j
		}
	}
	// Work folders of jobs that aren't queued any more are leftovers.
	entries, _ := os.ReadDir(*ytDir)
	for _, e := range entries {
		if j := ytJobs[e.Name()]; e.IsDir() && (j == nil || j.Status != "queued") {
			os.RemoveAll(filepath.Join(*ytDir, e.Name()))
		}
	}
}

func ytFreeGB() int64 {
	var st syscall.Statfs_t
	if syscall.Statfs(*ytDir, &st) != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize) / 1e9
}

func ytSet(j *ytJob, f func()) {
	ytMu.Lock()
	f()
	j.Updated = time.Now()
	ytSave()
	ytMu.Unlock()
}

// ---------- HTTP ----------

func handleYT(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/yt/jobs":
		ytMu.Lock()
		list := make([]*ytJob, 0, len(ytJobs))
		for _, j := range ytJobs {
			c := *j
			c.cancel = nil
			list = append(list, &c)
		}
		ytMu.Unlock()
		sort.Slice(list, func(a, b int) bool { return list[a].Added.After(list[b].Added) })
		updated, _ := os.ReadFile(filepath.Join(*ytDir, ".updated"))
		jsonOut(w, 200, map[string]any{"jobs": list, "free_gb": ytFreeGB(), "min_free_gb": *ytMinFree, "ytdlp_updated": strings.TrimSpace(string(updated))})
		return
	case "/yt/playlist":
		handlePlaylist(w, r)
		return
	case "/yt/add", "/yt/cancel", "/yt/forget":
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		jsonOut(w, 405, map[string]string{"error": "POST only"})
		return
	}
	var req struct {
		ID      string `json:"id"`
		Quality string `json:"quality"`
		Dest    string `json:"dest"`
		Name    string `json:"name"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req) != nil || !ytIDRe.MatchString(req.ID) {
		jsonOut(w, 400, map[string]string{"error": "id must be an 11-character YouTube id"})
		return
	}
	ytMu.Lock()
	defer ytMu.Unlock()
	j := ytJobs[req.ID]
	switch r.URL.Path {
	case "/yt/add":
		if req.Quality == "" {
			req.Quality = "1080"
		}
		if _, ok := qualities[req.Quality]; !ok {
			jsonOut(w, 400, map[string]string{"error": "quality must be 720, 1080 or 2160"})
			return
		}
		if *ytDest == "" || (req.Dest == "tv" && *ytTVDest == "") {
			jsonOut(w, 503, map[string]string{"error": "YouTube downloads are not configured on the box (-yt-dest / -yt-tv-dest)"})
			return
		}
		name, ok := tvName(req.Dest, req.Name)
		if !ok {
			jsonOut(w, 400, map[string]string{"error": "dest must be youtube, or tv with a name like Show/Season 01/Show - S01E01 - Title [id]"})
			return
		}
		if j != nil && j.Status != "done" && j.Status != "failed" {
			jsonOut(w, 200, j) // already queued or running
			return
		}
		if j == nil {
			j = &ytJob{ID: req.ID, Added: time.Now()}
			ytJobs[req.ID] = j
		}
		j.Quality, j.Status, j.Progress, j.Error, j.Updated = req.Quality, "queued", 0, "", time.Now()
		j.Dest, j.Name, j.Path, j.Size = "", "", "", 0
		if name != "" {
			j.Dest, j.Name = "tv", name
		}
		ytSave()
		select {
		case ytWake <- struct{}{}:
		default:
		}
		jsonOut(w, 200, j)
	case "/yt/cancel":
		if j == nil {
			jsonOut(w, 404, map[string]string{"error": "no such job"})
			return
		}
		if j.cancel != nil {
			j.cancel() // the runner marks it failed and cleans up
		} else if j.Status == "queued" {
			j.Status, j.Error, j.Updated = "failed", "cancelled", time.Now()
			ytSave()
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
	case "/yt/forget":
		if j != nil && j.cancel == nil && (j.Status == "done" || j.Status == "failed") {
			delete(ytJobs, req.ID)
			ytSave()
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
	}
}

// ---------- runner ----------

func ytRunner() {
	for {
		var next *ytJob
		ytMu.Lock()
		for _, j := range ytJobs {
			if j.Status == "queued" && (next == nil || j.Added.Before(next.Added)) {
				next = j
			}
		}
		// Forget finished jobs after two weeks.
		for id, j := range ytJobs {
			if (j.Status == "done" || j.Status == "failed") && time.Since(j.Updated) > 14*24*time.Hour {
				delete(ytJobs, id)
			}
		}
		var ctx context.Context
		if next != nil {
			ctx, next.cancel = context.WithCancel(context.Background())
		}
		ytMu.Unlock()
		if next == nil {
			select {
			case <-ytWake:
			case <-time.After(time.Minute):
			}
			continue
		}
		err := ytRun(ctx, next)
		work := filepath.Join(*ytDir, next.ID)
		os.RemoveAll(work)
		ytSet(next, func() {
			next.cancel = nil
			if err != nil {
				next.Status, next.Error = "failed", err.Error()
				if ctx.Err() != nil {
					next.Error = "cancelled"
				}
			}
		})
		if err != nil {
			log.Printf("yt %s failed: %v", next.ID, err)
		} else {
			log.Printf("yt %s done: %s (%d bytes)", next.ID, next.Path, next.Size)
		}
		go notify(next.ID, next.Status)
	}
}

func ytRun(ctx context.Context, j *ytJob) error {
	if free := ytFreeGB(); free < *ytMinFree {
		return fmt.Errorf("the download box is nearly full (%d GB free, needs %d GB)", free, *ytMinFree)
	}
	maybeUpdate(ctx, 24*time.Hour)
	work := filepath.Join(*ytDir, j.ID)
	os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return err
	}
	ytSet(j, func() { j.Status, j.Progress = "downloading", 0 })
	err := download(ctx, j, work)
	if err != nil && ctx.Err() == nil && retryable(err) && maybeUpdate(ctx, time.Hour) {
		os.RemoveAll(work)
		os.MkdirAll(work, 0o700)
		err = download(ctx, j, work) // yt-dlp was out of date: try again with the new one
	}
	if err != nil {
		return err
	}
	ytSet(j, func() { j.Status = "processing" })
	out, rel, size, err := arrange(ctx, j, work)
	if err != nil {
		return err
	}
	ytSet(j, func() { j.Status, j.Path, j.Size = "uploading", rel, size })
	video := filepath.Base(rel)
	// Sidecars first, then everything (the video), so the library never lists a video without its metadata.
	dest := *ytDest
	if j.Dest == "tv" {
		dest = *ytTVDest
	}
	if err := rsync(ctx, out, dest, "--exclude="+rsyncEscape(video)); err != nil {
		return err
	}
	if err := rsync(ctx, out, dest); err != nil {
		return err
	}
	ytSet(j, func() { j.Status, j.Progress = "done", 1 })
	return nil
}

func retryable(err error) bool {
	s := strings.ToLower(err.Error())
	for _, k := range []string{"sign in", "not a bot", "403", "unable to extract", "nsig", "signature", "player", "requested format is not available", "no video formats"} {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

// Updates yt-dlp with pip if the last update is older than `every`. Returns true if it updated.
func maybeUpdate(ctx context.Context, every time.Duration) bool {
	stamp := filepath.Join(*ytDir, ".updated")
	if fi, err := os.Stat(stamp); err == nil && time.Since(fi.ModTime()) < every {
		return false
	}
	py := filepath.Join(filepath.Dir(*ytdlpBin), "python")
	c, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(c, py, "-m", "pip", "install", "-q", "-U", "pip", "yt-dlp[default]").CombinedOutput()
	if err != nil {
		log.Printf("yt-dlp update failed: %v %s", err, lastLines(string(out), 3))
		os.WriteFile(stamp, []byte(time.Now().UTC().Format(time.RFC3339)+" (update failed)"), 0o600) // don't retry every job
		return false
	}
	v, _ := exec.CommandContext(c, *ytdlpBin, "--version").Output()
	os.WriteFile(stamp, []byte(time.Now().UTC().Format(time.RFC3339)+" yt-dlp "+strings.TrimSpace(string(v))), 0o600)
	log.Printf("yt-dlp updated to %s", strings.TrimSpace(string(v)))
	return true
}

func download(ctx context.Context, j *ytJob, work string) error {
	var last error
	for _, clients := range strings.Split(*ytClients, ";") {
		clients = strings.TrimSpace(clients)
		args := []string{"--ignore-config", "--no-playlist", "--newline", "--no-colors", "--progress", "--progress-template", "download:PROG %(progress._percent_str)s",
			"--js-runtimes", *ytJS, "--remote-components", "ejs:github",
			"--merge-output-format", "mp4", "--embed-chapters",
			"--write-info-json", "--write-thumbnail", "--convert-thumbnails", "jpg",
			"--write-subs", "--sub-langs", "en.*,en", "--convert-subs", "srt",
			"--match-filter", "!is_live & live_status!=is_upcoming", "--max-filesize", "40G",
			"-P", work, "-o", "video.%(ext)s"}
		if clients != "" && clients != "default" {
			args = append(args, "--extractor-args", "youtube:player_client="+clients)
		}
		args = append(args, qualities[j.Quality]...)
		if *ytProxy != "" {
			args = append(args, "--proxy", *ytProxy)
		}
		args = append(args, strings.Fields(*ytExtra)...)
		args = append(args, "https://www.youtube.com/watch?v="+j.ID)
		cmd := exec.CommandContext(ctx, *ytdlpBin, args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		stdout, _ := cmd.StdoutPipe()
		if err := cmd.Start(); err != nil {
			return err
		}
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if m := pctRe.FindStringSubmatch(strings.TrimSpace(sc.Text())); m != nil {
				p, _ := strconv.ParseFloat(m[1], 64)
				ytMu.Lock()
				j.Progress = p / 100 // per stream (video, then audio); good enough for a progress label
				ytMu.Unlock()
			}
		}
		err := cmd.Wait()
		if err == nil {
			ytSet(j, func() { j.Client = clients })
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		msg := ytError(stderr.String())
		last = errors.New(msg)
		log.Printf("yt %s with clients %q: %s", j.ID, clients, msg)
		if !retryable(last) {
			return last // private, removed, members-only, live...: other clients won't help
		}
		// Clear partial files before the next client set.
		entries, _ := os.ReadDir(work)
		for _, e := range entries {
			os.RemoveAll(filepath.Join(work, e.Name()))
		}
	}
	return last
}

func ytError(stderr string) string {
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(lines[i], "ERROR:") {
			s := strings.TrimSpace(strings.TrimPrefix(lines[i], "ERROR:"))
			s = regexp.MustCompile(`^\[youtube\] [A-Za-z0-9_-]{11}: `).ReplaceAllString(s, "")
			if i := strings.Index(s, " Use --cookies"); i > 0 {
				s = s[:i]
			}
			return truncate(s, 300)
		}
	}
	if len(lines) > 0 && lines[0] != "" {
		return truncate(lastLines(stderr, 1), 300)
	}
	return "yt-dlp failed"
}

// The metadata we keep (the full info.json is ~600 KB of formats).
type ytInfo struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Channel     string   `json:"channel,omitempty"`
	ChannelID   string   `json:"channel_id,omitempty"`
	Uploader    string   `json:"uploader,omitempty"`
	UploadDate  string   `json:"upload_date,omitempty"`
	Timestamp   int64    `json:"timestamp,omitempty"`
	Duration    float64  `json:"duration,omitempty"`
	Description string   `json:"description,omitempty"`
	Categories  []string `json:"categories,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	AgeLimit    int      `json:"age_limit"`
	WebpageURL  string   `json:"webpage_url,omitempty"`
	Width       int      `json:"width,omitempty"`
	Height      int      `json:"height,omitempty"`
	Downloaded  string   `json:"downloaded,omitempty"`
}

// Moves the download into out/<channel>/<title> [<id>].* and makes the poster. Returns out, the video's path
// relative to media/youtube, and its size.
func arrange(ctx context.Context, j *ytJob, work string) (string, string, int64, error) {
	var info ytInfo
	b, err := os.ReadFile(filepath.Join(work, "video.info.json"))
	if err != nil || json.Unmarshal(b, &info) != nil || info.ID != j.ID {
		return "", "", 0, errors.New("yt-dlp wrote no usable metadata")
	}
	entries, _ := os.ReadDir(work)
	video := ""
	for _, e := range entries {
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if strings.HasPrefix(e.Name(), "video.") && strings.Count(e.Name(), ".") == 1 && (ext == ".mp4" || ext == ".mkv" || ext == ".webm") {
			video = e.Name()
		}
	}
	if video == "" {
		return "", "", 0, errors.New("yt-dlp produced no video file")
	}
	channel := clean(firstNonEmpty(info.Channel, info.Uploader, "Unknown channel"), 80)
	dir, base := channel, clean(firstNonEmpty(info.Title, info.ID), 150)+" ["+info.ID+"]"
	if j.Dest == "tv" { // an episode: the TV library's own naming, no YouTube sidecars (TMDB describes it)
		dir, base = filepath.Dir(j.Name), filepath.Base(j.Name)
	}
	out := filepath.Join(work, "out")
	dst := filepath.Join(out, dir)
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return "", "", 0, err
	}
	if len(info.Tags) > 30 {
		info.Tags = info.Tags[:30]
	}
	info.Description = truncate(info.Description, 5000)
	info.Downloaded = time.Now().UTC().Format(time.RFC3339)
	meta, _ := json.MarshalIndent(info, "", " ")
	if j.Dest != "tv" {
		if err := os.WriteFile(filepath.Join(dst, base+".info.json"), meta, 0o644); err != nil {
			return "", "", 0, err
		}
	}
	if _, err := os.Stat(filepath.Join(work, "video.jpg")); err == nil && j.Dest != "tv" {
		os.Rename(filepath.Join(work, "video.jpg"), filepath.Join(dst, base+".jpg"))
		// A 2:3 poster for apps that show portrait art: the thumbnail over a blurred, darkened copy of itself.
		c, cancel := context.WithTimeout(ctx, time.Minute)
		o, err := exec.CommandContext(c, *ffmpeg, "-nostdin", "-y", "-loglevel", "error", "-i", filepath.Join(dst, base+".jpg"), "-filter_complex",
			"[0]scale=600:900:force_original_aspect_ratio=increase,crop=600:900,boxblur=28:2,eq=brightness=-0.12[bg];[0]scale=600:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2",
			"-frames:v", "1", "-q:v", "3", filepath.Join(dst, base+".poster.jpg")).CombinedOutput()
		cancel()
		if err != nil {
			log.Printf("yt %s poster: %v %s", j.ID, err, lastLines(string(o), 2))
		}
	}
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, "video.") && strings.HasSuffix(n, ".srt") { // video.en.srt, video.en-US.srt
			os.Rename(filepath.Join(work, n), filepath.Join(dst, base+strings.TrimPrefix(n, "video")))
		}
	}
	ext := strings.ToLower(filepath.Ext(video))
	if err := os.Rename(filepath.Join(work, video), filepath.Join(dst, base+ext)); err != nil {
		return "", "", 0, err
	}
	fi, err := os.Stat(filepath.Join(dst, base+ext))
	if err != nil {
		return "", "", 0, err
	}
	ytSet(j, func() { j.Title, j.Channel = info.Title, channel })
	return out, dir + "/" + base + ext, fi.Size(), nil
}

func rsync(ctx context.Context, src, dest string, extra ...string) error {
	args := append([]string{"-rt", "--chmod=D755,F644", "--timeout=185", "--partial-dir=.rsync-partial", "-e", "ssh -o BatchMode=yes"}, extra...)
	args = append(args, src+"/", dest)
	for attempt := 1; ; attempt++ {
		out, err := exec.CommandContext(ctx, "rsync", args...).CombinedOutput()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil || attempt == 3 {
			return fmt.Errorf("copy to HostBRR failed: %v %s", err, truncate(lastLines(string(out), 2), 200))
		}
		time.Sleep(time.Duration(attempt) * 20 * time.Second)
	}
}

func rsyncEscape(s string) string {
	return regexp.MustCompile(`([*?\[\]\\])`).ReplaceAllString(s, `\$1`)
}

// File/folder-name safe: no slashes or control characters, no leading/trailing dots or spaces, bounded length.
func clean(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '/' || r == '\\' || unicode.IsControl(r):
			return ' '
		case r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|':
			return '-'
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	s = truncate(s, max)
	s = strings.Trim(s, " .")
	if s == "" {
		s = "untitled"
	}
	return s
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	s = s[:max]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

// Tells the Worker a job finished (signed with the qBittorrent hook's secret).
func notify(id, status string) {
	env := map[string]string{}
	b, err := os.ReadFile(*hookEnv)
	if err != nil {
		return
	}
	for _, l := range strings.Split(string(b), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(l), "="); ok {
			env[k] = strings.Trim(v, `"'`)
		}
	}
	url, secret := strings.Replace(env["WATCH_HOOK_URL"], "/hooks/qbit", "/hooks/youtube", 1), env["WATCH_HOOK_SECRET"]
	if url == "" || secret == "" {
		return
	}
	body := fmt.Sprintf(`{"id":%q,"status":%q,"at":%d}`, id, status, time.Now().Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	for attempt := 0; attempt < 3; attempt++ {
		req, _ := http.NewRequest("POST", url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Watch-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		c := &http.Client{Timeout: 20 * time.Second}
		if res, err := c.Do(req); err == nil {
			res.Body.Close()
			if res.StatusCode < 300 {
				return
			}
		}
		time.Sleep(10 * time.Second)
	}
	log.Printf("yt %s: hook failed", id)
}

// Validates a TV episode name from the Worker: exactly "<Show>/<Season folder>/<file name>", each part already
// file-name safe (clean() leaves it unchanged) and the file name ending in the video's [id].
func tvName(dest, name string) (string, bool) {
	if dest == "" || dest == "youtube" {
		return "", name == ""
	}
	if dest != "tv" {
		return "", false
	}
	parts := strings.Split(name, "/")
	if len(parts) != 3 || len(name) > 400 {
		return "", false
	}
	for _, p := range parts {
		if p == "" || p != clean(p, 200) {
			return "", false
		}
	}
	if !regexp.MustCompile(`\[[A-Za-z0-9_-]{11}\]$`).MatchString(parts[2]) {
		return "", false
	}
	return name, true
}

var listRe = regexp.MustCompile(`^[A-Za-z0-9_-]{10,64}$`)

// GET /yt/playlist?list=<id>: the playlist's title and videos (no download), for the Worker's preview.
func handlePlaylist(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("list")
	if !listRe.MatchString(id) {
		jsonOut(w, 400, map[string]string{"error": "bad playlist id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	args := []string{"--ignore-config", "--flat-playlist", "-J", "--no-warnings", "--playlist-end", "300"}
	if *ytProxy != "" {
		args = append(args, "--proxy", *ytProxy)
	}
	args = append(args, strings.Fields(*ytExtra)...)
	args = append(args, "https://www.youtube.com/playlist?list="+id)
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, *ytdlpBin, args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		jsonOut(w, 502, map[string]string{"error": ytError(stderr.String())})
		return
	}
	var d struct {
		Title    string `json:"title"`
		Channel  string `json:"channel"`
		Uploader string `json:"uploader"`
		Entries  []struct {
			ID       string  `json:"id"`
			Title    string  `json:"title"`
			Duration float64 `json:"duration"`
			Channel  string  `json:"channel"`
		} `json:"entries"`
	}
	if json.Unmarshal(out, &d) != nil {
		jsonOut(w, 502, map[string]string{"error": "yt-dlp returned no playlist"})
		return
	}
	type entry struct {
		ID       string  `json:"id"`
		Title    string  `json:"title"`
		Duration float64 `json:"duration"`
		Channel  string  `json:"channel,omitempty"`
	}
	list := []entry{}
	for _, e := range d.Entries {
		if ytIDRe.MatchString(e.ID) && e.Title != "[Private video]" && e.Title != "[Deleted video]" {
			list = append(list, entry{e.ID, e.Title, e.Duration, e.Channel})
		}
	}
	jsonOut(w, 200, map[string]any{"id": id, "title": d.Title, "channel": firstNonEmpty(d.Channel, d.Uploader), "entries": list})
}
