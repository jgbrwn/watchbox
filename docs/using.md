# Using watchbox

## Apps

Add `https://watch.example.com` as a Jellyfin server and sign in. Tested with VidHub, the official Jellyfin apps
(Android TV, Android, iOS, Fire TV), Swiftfin, Findroid and Streamyfin. Continue watching, next up, favorites,
played/unplayed, resume across devices, subtitles (external SRT/VTT/ASS) and multiple versions of a title work as in
Jellyfin. Apps play the original files (no server-side transcoding), so the device must support the codec; VidHub and
the Jellyfin apps on Android TV play almost anything.

**Quick Connect:** apps that support it (the official Jellyfin apps, Swiftfin, Findroid, Streamyfin; not VidHub or
Infuse) show a 6-digit code instead of asking for a password. Approve it on `/me` (guests), on `/admin` → Users, or
from another signed-in app.

## Naming files

Movies: `Title (Year)/Title (Year).mkv`, or loose `Title.Year.1080p.mkv`; extra versions in the same folder become
versions of one movie ("Extended", "4K" …); `-sample`, trailers and extras are recognised and kept out of the library.
TV: `Show (Year)/Season 1/Show S01E02.mkv` (also `1x02`, `Episode 2`, absolute numbering, multi-episode `S01E01-E02`).
Subtitles next to the video with the same name (`Title (Year).en.srt`, `.forced.srt`). Wrong match: fix it on the
admin page (Library → the unmatched list's TMDB form, or paste a TMDB link for any key).

## The admin page (`/admin`)

| Tab | |
|---|---|
| Library | search and **watch in the browser**, recently added, storage and box disk meters, unmatched files with a fix form, *Sync now*, sync log |
| Manage | find files; lists of sample clips, very short files, duplicate copies and extras; delete into a 14-day trash with **Restore** (refused while a download is still on the box) |
| Users | invite people by email (or create a plain login), age limits, devices with location and sign-out, Quick Connect, share links, title age ratings, test email |
| Pipeline | requests from guests, YouTube (videos and playlists), finished downloads with **Send to library**, downloads in progress, copy history, auto-send and cleanup settings |
| Find · Downloads · Transfer | the download box's c-cli, qBittorrent (VueTorrent) and rsync-web, if you have one |

The theme button in the header cycles automatic (follows the system), dark and light, and is remembered per browser.
Find, Downloads and Transfer follow it: open tabs switch along (Downloads reloads to do so), and so do tools opened
with *Open in new tab*.

### Duplicates

watchbox checks for titles you already have at three points. It warns rather than refuses, since a second copy can
be an upgrade (a better rip, a higher resolution):

- **Find:** search results and title pages are marked *In library · 1080p* (shows: which seasons) or *Downloading now*,
  matched by IMDb id, and downloading one of them asks *Download anyway?* first.
- **Auto-send:** a finished download that's a movie you already have, or a season pack whose episodes are all in the
  library, isn't sent automatically. Pipeline marks it *⚠ Duplicate* with **Send anyway** and **Remove from box**.
  Packs that add new episodes are sent as usual (with a note of how many you had).
- **Requests:** asking for a title that is already downloading on the box (or approving such a request) follows that
  download instead of starting another one; the people who asked are emailed when it's in the library.

### Big downloads

The download box only needs room for part of a download:

- **Find** marks torrents bigger than the box's free space and asks before *⬇ Server* downloads one.
- A pack of many files (a season, a complete series) that doesn't fit is **downloaded in parts**: as many files as
  fit, sent to the library and removed from the box, then the next ones. Pipeline shows the progress
  (*part 2 … · 8 of 20 files sent*). Episodes show up in the library part by part. These downloads don't seed afterwards.
- A single file bigger than the free space can't be split. In a pack, it's left for last and everything else is
  downloaded and sent first. When only that file is left (or the torrent is just that file), the download is stopped and
  Pipeline marks it *too big*, with **Remove from box**. It carries on by itself if space frees up later. Otherwise pick
  a smaller release (for example x265 instead of a remux). Find only knows a torrent's total size, so this shows up
  once the download has started.
- Several downloads waiting for space take turns in the order they started waiting. A smaller one can go ahead in
  the meantime, but nothing jumps the queue past a download that has waited 12 hours. If it's still short of space
  then, finished downloads that are already in the library stop seeding early (shown in Pipeline as *seeding ended
  early*) to make room.
- Guest requests that download automatically pick the best release that fits.

## Guests (`/me`)

Invite someone on Users: they get an email with a link, sign in to `/me` with a one-time code sent to that email,
set their password, and follow the setup steps for their TV or phone. On `/me` they can browse and watch in the
browser, ask for movies, shows or YouTube videos (paste a link), see their requests' progress, manage their devices
and share links. Each person has their own progress and favorites; nobody sees anyone else's.

Requests: you approve or decline on Pipeline. *Download* picks the best 1080p YTS torrent with seeders; shows are
found by hand on Find. A person marked *auto-approve* gets movies and YouTube videos downloaded straight away
(playlists up to 25 videos). Everyone who asked is emailed when the title is in the library.

## YouTube

Paste a video or playlist link on Pipeline → YouTube and pick 720p, 1080p or 4K. Videos land in a **YouTube**
library (channel as studio, upload date, description, thumbnail and poster). A playlist opens a preview where you can
save it as **episodes of a TV show** instead: season and episode numbers are read from the titles ("S01E09", "Season
1 Episode 9") and editable; the files then join the show in your TV library, and where you already had an episode,
both become versions (the bigger file plays by default; delete the old one under Manage → duplicates).

## Share links

On a movie or episode's watch page, *Share link* makes `https://watch.example.com/s/<random>` that plays that one
title in any browser without signing in: 1, 7 or 30 days (you can also make never-expiring ones), revocable any time
(Users → Shared links), views counted. Guests can make them if you allow it. A link reaches only that title.

## Age limits

Give a person an age limit (7, 12, 14, 16) on Users. Ages come from certificates (US first, then other countries
from TMDB). A limited person only sees titles at or under their limit, everywhere (apps, search, continue watching,
/me, streams). Unrated titles, including YouTube videos, are hidden unless you allow unrated for them or give the title
an age under Users → Age ratings. Give kids their own login: a TV signed in as an adult shows everything.

Requests follow the same rule: a limited person can't ask for a title above their limit, or an unrated one (any
YouTube video) unless unrated is allowed for them. /me's search marks those, asking is refused with the reason, and
you aren't emailed about it. Anything they can ask for comes to you to approve, even with auto-approve on.
