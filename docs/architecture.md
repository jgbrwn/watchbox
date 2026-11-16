# Architecture

## The pieces

| Piece | Runs on | Does |
|---|---|---|
| **Worker** (`worker/src`) | Cloudflare Workers | The Jellyfin API for apps, the admin page `/admin`, the guest page `/me`, share links `/s/…`, the browser player, the 15-minute library sync |
| **D1 database** | Cloudflare | The library catalog, users and sessions, watch progress, favorites, requests, share links, settings |
| **Access** (Zero Trust) | Cloudflare | Logins for `/admin` (your email only) and `/me` (any email; the Worker admits only your users), by one-time PIN |
| **Storage** (`storage/`) | shared hosting or a VPS | Your video files, served with byte ranges behind Basic auth; `list.php` lists them, `manage.php` moves deleted ones to a trash with restore |
| **Download box** (`box/`, optional) | a small VPS | qBittorrent (with VueTorrent), c-cli to find torrents, rsync-web to copy to storage, watch-stream for browser conversions and YouTube downloads, all behind Caddy |
| **TMDB** | themoviedb.org | Titles, posters, cast, episodes, certificates (age ratings) |

Video never touches Cloudflare's storage: apps request `/Videos/<id>/stream`, and the Worker fetches the requested byte
range from the storage host and passes it through. Posters come from TMDB's CDN through the Worker (cached).

## The library sync

Every 15 minutes (and right after a download lands) the Worker:

1. finishes download-pipeline steps a webhook missed, and hands waiting YouTube jobs to the box,
2. reads `list.php` and compares it with the database: new files are added, moved files keep their id, deleted ones
   are hidden. If a folder suddenly lost more than 20% of its files (a broken mount looks like that), or a folder is
   missing from the listing, the sync refuses to apply it,
3. parses new file names (`Movie (2020).mkv`, `Show/Season 1/Show S01E02.mkv`, …) and matches them on TMDB;
   YouTube videos are described by their `.info.json` sidecar instead,
4. reads each new file's headers over byte ranges for the exact duration, codecs and resolution,
5. rebuilds the `items` table the API serves, and computes each title's minimum age,
6. marks requests whose title arrived as ready and emails the people who asked,
7. once a day, empties trash older than 14 days.

Unmatched files still appear (named from the file) and are retried daily. A wrong match is fixed on the admin page
(Library → unmatched / fix form) and saved as an override.

## Folders ("library roots")

The storage host lists one or more folders, each feeding a library: `movies`, `tv` or `youtube`. A fresh install has
one of each. Every file's id is a hash of `<folder id>/<path>`, so **never rename a folder id** once the library is
built (watch progress is keyed by file id). Moving a file within the storage keeps its id when the listing can
recognise it (same inode and size). Several folders per library are allowed (for example two disks); give the one new
files should go to `"priority": 0` and the others `1` in `LIBRARY_ROOTS`, and list the same ids in the storage's
`config.php`.

## Downloads (optional download box)

```
c-cli (find) → .torrent into ~ → qBittorrent downloads into ~/media
  → "torrent finished" hook pokes the Worker → rsync-web copies it to storage (movies/ or tv/, guessed from the name)
  → rsync-web's webhook → the Worker checks every video file arrived at the same size → library sync
  → after the seed ratio / time you set, the Worker has qBittorrent delete it from the box
YouTube link → the Worker asks watch-stream → yt-dlp → files named <channel>/<title> [id].mp4 (+ metadata, poster,
  subtitles) → rsync to storage youtube/ (or tv/<Show>/Season NN/ for playlists saved as a show) → hook → sync
```

Nothing on the storage host is ever deleted by the pipeline; deleting is only through the admin page's Manage tab,
into a trash you can restore from.

## Where state lives

| What | Where | Backed up by |
|---|---|---|
| Video files, subtitles | storage host | you |
| Library, users, progress, requests | D1 | D1 Time Travel (30 days) |
| Secrets (storage password, keys, tokens) | Worker secrets; the installers' private folders | you (keep the printed values) |
| Configuration | `worker/wrangler.<name>.jsonc` written by setup | re-running setup |

The Worker holds no video and no long-lived credentials of yours besides the storage password and the download box
login it needs.
