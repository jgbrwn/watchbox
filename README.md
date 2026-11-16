# watchbox

Your own movie and TV server, without running a media server. **watchbox** speaks the Jellyfin API from a Cloudflare
Worker, streams your video files straight from a storage host you already have (cheap shared hosting with PHP, or a
VPS), and gets its posters and metadata from TMDB. Use it with VidHub, the official Jellyfin apps (Android TV, iOS,
Android, Fire TV), Swiftfin, Findroid, Streamyfin and other Jellyfin clients.

Optional extras: a **download box** (any small Linux or FreeBSD VPS) to find and download new titles and YouTube
videos and copy them to your storage automatically, **browser playback** with on-the-fly conversion, **invited
guests** with their own logins and requests, **age limits** for kids, and **share links** for one title.

```
 Storage host (PHP + your files)                Cloudflare
 ├─ src/<folder>/<file>  ← byte ranges ───────── Worker ── Jellyfin API ── TV / phone apps
 ├─ list.php             ← every 15 min ───────   │  ├── /admin   (Access: you)        ┐
 └─ manage.php           ← delete / restore ───   │  ├── /me      (Access: guests)     ├─ browser player
                                                   │  └── /s/<id>  (public share link)  ┘
 TMDB                    ← match, art, ratings ───┤  D1: library, users, progress, requests
 Download box (optional, Caddy + HTTPS) ──────────┘  qBittorrent + VueTorrent, c-cli, rsync-web, watch-stream
   finished downloads and YouTube videos ──rsync──▶ storage host
```

## What you need

- A domain on **Cloudflare**, the **Workers Paid** plan ($5/month: the library sync needs more CPU time than the
  free plan allows), and **Zero Trust** (the free plan) for the admin and guest logins.
- A **storage host** with your videos: shared hosting with PHP 8 and SSH (DirectAdmin and cPanel are supported,
  including [HostBRR storage plans](docs/storage-shared-hosting.md#hostbrr)), or a Debian/Ubuntu VPS.
- A free **TMDB** API read token.
- Optional: a **download box**, a small Debian, Ubuntu or FreeBSD VPS.

## Install (three parts, about 20 minutes)

Download the latest release (`watchbox-<version>.tar.gz` from [Releases](../../releases)) onto each server, or
clone this repository.

1. **Storage**
   - VPS: `sudo sh storage/install.sh --domain storage.example.com` → [docs/storage-vps.md](docs/storage-vps.md)
   - Shared hosting: `sh storage/install-shared.sh --web-dir … --media-dir … --domain …` →
     [docs/storage-shared-hosting.md](docs/storage-shared-hosting.md)
2. **Download box** (optional): `sudo sh box/install.sh --domain box.example.com --worker https://watch.example.com
   --storage watchbox@storage.example.com` (FreeBSD: `box/install-freebsd.sh`) → [docs/download-box.md](docs/download-box.md).
   Then give the box's key to the storage installer (`--box-key`).
3. **Cloudflare**: `cd worker && npm install && npm run setup -- --answers my-answers.json` creates the database,
   logins and Worker and deploys it → [docs/cloudflare.md](docs/cloudflare.md)

Each step prints the values the next one needs. Then add `https://watch.example.com` as a Jellyfin server in your
app, sign in with the login the setup printed, and open `https://watch.example.com/admin`.

## Documentation

| | |
|---|---|
| [Using watchbox](docs/using.md) | apps, the admin page, guests and requests, YouTube, share links, age limits |
| [Architecture](docs/architecture.md) | how the pieces fit, what is stored where, the library sync |
| [Storage on a VPS](docs/storage-vps.md) · [on shared hosting](docs/storage-shared-hosting.md) | installing, folders, disk usage, HostBRR |
| [Download box](docs/download-box.md) | Debian/Ubuntu and FreeBSD, YouTube, the pipeline |
| [Cloudflare setup](docs/cloudflare.md) | the setup wizard, API tokens, email, by hand |
| [Security](docs/security.md) | the security model and the server checks |
| [Upgrading](docs/upgrading.md) · [Troubleshooting](docs/troubleshooting.md) | |

## Legal

watchbox streams files you provide. The download box includes a BitTorrent client and a YouTube downloader: use them
only for content you have the right to download, and follow the terms of the services you use. Both are optional.

## License

MIT, see [LICENSE](LICENSE). Bundled: [hls.js](worker/vendor/) (Apache-2.0). The download box installs
[c-cli](https://github.com/jgbrwn/c-cli), [rsync-web](https://github.com/jgbrwn/rsync-web),
[qBittorrent](https://www.qbittorrent.org/), [VueTorrent](https://github.com/VueTorrent/VueTorrent),
[yt-dlp](https://github.com/yt-dlp/yt-dlp), [Caddy](https://caddyserver.com/) and FFmpeg from their own sources.
