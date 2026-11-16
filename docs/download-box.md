# The download box (optional)

A small VPS (1–2 CPUs, 2 GB RAM, disk for downloads in progress) that finds and downloads titles, copies finished
downloads to your storage, downloads YouTube videos, and converts videos browsers can't play. Debian 12+/Ubuntu 22.04+
or FreeBSD 14+.

## Install

Point three names at the box (A/AAAA records, not proxied): `cc.box.example.com`, `dl.box.example.com`,
`rs.box.example.com`. Then:

```sh
sudo sh box/install.sh --domain box.example.com --worker https://watch.example.com \
   --storage watchbox@storage.example.com [--storage-port 22] [--storage-path DIR] [--omdb-key KEY] [--build] [--harden] [--firewall]
# FreeBSD: sh box/install-freebsd.sh with the same options
```

- `--worker`: your watchbox address (the box sends "download finished" notices there, and conversions only read from it).
- `--storage`: the SSH login on your storage host. `--storage-path` only if that host has no `rrsync` (shared hosting).
- `--omdb-key`: optional, a free [OMDb](https://www.omdbapi.com/apikey.aspx) key for posters and ratings in c-cli.

- `--build`: compile the box's own programs here instead of using prebuilt ones (see below).

### Where the programs come from

The box runs three small Go programs: **watch-stream** (part of watchbox, in `box/watch-stream/`), **c-cli-web**
([jgbrwn/c-cli](https://github.com/jgbrwn/c-cli)) and **rsync-web** ([jgbrwn/rsync-web](https://github.com/jgbrwn/rsync-web)),
at the commits pinned in `box/versions.env`. The installer gets them with `box/get-binaries.sh`:

- **From a release bundle**: they're already in `box/bin/<os>-<arch>/`, built by GitHub Actions for the release.
- **From a git clone** (default): it downloads the newest release (or `WATCHBOX_VERSION=v0.1.0`), checks it against
  the release's published SHA-256, and takes the programs for your system from it.
- **With `--build`** (from a git clone): it compiles them on the box: watch-stream from your checkout, the other two
  from their pinned commits, using the official Go toolchain downloaded from go.dev to a temporary folder (checksum
  verified) and deleted afterwards. Use this to run code you changed, or if you'd rather not run prebuilt binaries.

Everything else (qBittorrent, Caddy, FFmpeg, Node or Deno, Python for yt-dlp) comes from the system's packages;
VueTorrent and yt-dlp are downloaded from their official releases (VueTorrent checksum-pinned).

It installs and starts (as the user `watchbox`, listening on 127.0.0.1 only):

| Service (systemd / FreeBSD rc.d) | What | Behind |
|---|---|---|
| `watchbox-qbittorrent` / `qbittorrent` | qBittorrent with the VueTorrent web UI; watches `~watchbox` for .torrent files, downloads into `~/media` | `https://dl.<domain>` |
| `watchbox-c-cli-web` / `watchbox_ccli` | c-cli: search YTS and torrents-csv, "download .torrent to server" | `https://cc.<domain>` |
| `watchbox-rsync-web` / `watchbox_rsyncweb` | rsync-web: copies `~/media/<download>` to storage (presets Movies, TV) | `https://rs.<domain>` |
| `watchbox-stream` / `watchbox_stream` | watch-stream: browser conversions (FFmpeg → HLS) and YouTube downloads (yt-dlp) | `https://dl.<domain>/__watchstream/` |

Caddy terminates HTTPS with Basic auth: user `owner` (you, in a browser) and `watchworker` (the Worker); it refuses
cross-site browser requests, so another web page can't use your browser's saved login. The installer generates both
passwords, an SSH key for the storage host, and the shared secret for the notices, then prints:

- your login for the three tools,
- the box's **public key**: add it on the storage host (`--box-key` in the storage installer),
- the values for the Cloudflare setup (`TOOLS`, `TOOLS_AUTHORIZATION`, `RSYNC_WEBHOOK_SECRET`), also in
  `/var/lib/watchbox-box/cloudflare-values.txt` (FreeBSD: `/var/db/watchbox-box/`).

In the admin page the three tools appear as tabs (through the Worker, on `watch-cc/dl/rs.<your domain>`), so you
rarely open them directly.

## The pipeline

On the admin page's **Pipeline** tab: *Send finished downloads automatically* copies each finished torrent to storage
(movies or TV, guessed from its name; you can send by hand too), and *Then remove them from the download box* deletes
it from the box once every video file is confirmed on storage at the same size and after seeding to the ratio or hours
you set. Nothing on storage is ever deleted. It refuses to send when the storage host has less than 50 GB free.

## YouTube

Paste a video or playlist link on the Pipeline tab (or approve a guest's request). The box downloads with yt-dlp
(H.264 up to 720p/1080p, or VP9 4K), writes `<channel>/<title> [id].mp4` plus metadata, thumbnail, a portrait
poster and English subtitles, and copies them to storage `youtube/` (playlists can be saved as episodes of a TV
show instead: `tv/<Show>/Season NN/`). yt-dlp updates itself daily.

YouTube blocks many datacenter IPs ("Sign in to confirm you're not a bot"). If downloads fail with that message,
send the box's YouTube traffic through another machine whose IP YouTube accepts, for example your storage host,
with an SSH tunnel:

1. On the box, as `watchbox`: `ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ytproxy`.
2. On that machine, add the public key to the SSH user's `~/.ssh/authorized_keys` as
   `command="/bin/false",restrict,port-forwarding,permitopen="*:443" ssh-ed25519 AAAA…` (it can then only open
   HTTPS connections: no shell, no files).
3. On the box, run the tunnel as a service: `ssh -N -D 127.0.0.1:1080 -i ~/.ssh/id_ytproxy -o ExitOnForwardFailure=yes
   -o ServerAliveInterval=30 user@host` (a systemd unit with `Restart=always`, or rc.d with `daemon -r`), and add
   `-yt-proxy socks5://127.0.0.1:1080` to watch-stream's command line.

## Browser conversions

Files browsers can play (MP4/MKV with H.264/HEVC/AV1 and common audio) play directly from storage. Others (old Xvid,
DTS audio, …) are converted on the box while you watch: video copied when possible, otherwise H.264; audio to AAC.
At most 3 at once, stopped after 10 idle minutes, refused below 15 GB free disk.
