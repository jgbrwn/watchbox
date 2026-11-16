# Troubleshooting

**The library is empty / doesn't update.** Admin page → Library → sync log. "listing HTTP 401": the storage password
in the Worker (`ORIGIN_AUTHORIZATION`) doesn't match. "root … shrank" or "listing missing root": a folder became
unreadable or a folder id in `LIBRARY_ROOTS` isn't in the storage's `config.php` (they must match). HTTP 403 from a
shared host: some hosts' firewalls block requests without a User-Agent (the Worker sends one; check with
`curl -A x -u user:pass https://storage.example.com/list.php`).

**A title is matched wrongly or not at all.** Library → Unmatched: paste the TMDB link for its key. Better file names
help (see [naming](using.md#naming-files)).

**Videos don't play in an app.** The app plays the original file. Check the codec on the admin page (Manage shows
resolution and codec); old Xvid/AVI files play in VidHub and the Jellyfin Android TV app but not in some Apple apps.
In the browser, such files are converted by the download box (needs one).

**The admin page asks to sign in again / "Access not configured".** `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and
`ADMIN_EMAIL_ALLOWLIST` must match your Access app; re-run setup.

**Guests can't get into /me.** They must use the email you invited; the Access login sends the code there. Check
Users → their status (invited / active / turned off).

**Emails don't arrive.** Set up Email Sending for your domain (see [Cloudflare](cloudflare.md#email)), then Users →
*Send me a test email*. Invites always show a shareable link as well.

**Download box tabs show an error.** `TOOLS_AUTHORIZATION` must be the `watchworker` login from the box installer;
the box's names (`cc/dl/rs.<domain>`) must resolve and have certificates (`journalctl -u caddy`, FreeBSD
`/var/log/caddy`). Services: `systemctl status watchbox-*` (FreeBSD: `service watchbox_stream status`, logs in
`/var/log/watchbox_*.log`).

**Finished downloads aren't copied.** Pipeline tab → errors at the top. The box must reach the storage host over SSH
with its key: as `watchbox` on the box, `rsync --list-only storage:` must list the folders.

**YouTube: "Sign in to confirm you're not a bot".** YouTube is blocking the box's IP; see
[Download box → YouTube](download-box.md#youtube).

**Run the server checks:** `sudo sh security-check.sh` on the storage VPS or box.
