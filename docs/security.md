# Security

## The model

- **Apps** authenticate like Jellyfin: username and password (PBKDF2, 100k iterations) or Quick Connect, giving a
  session token stored as a hash. Every library, metadata, stream and subtitle endpoint needs a token. Logins are
  rate-limited per IP and per username. Unauthenticated, the server only reveals its name and posters (by unguessable
  32-hex ids), like Jellyfin.
- **Admin and guest pages** sit behind Cloudflare Access (one-time PIN to your email; guests to theirs). The Worker
  verifies the Access token itself (signature, issuer, audience, email) and admits on `/me` only emails of people you
  added. Pages send `X-Frame-Options: DENY`, no third-party scripts.
- **Storage** is reachable only with its Basic-auth password, which only the Worker knows; it serves three things:
  the listing, the delete/restore endpoint and the files. Deletes additionally need an HMAC-SHA256 signature with a
  separate key, are refused when older than 5 minutes, only move files into a trash inside the library folder, and
  never follow symlinks or `..`.
- **The download box** apps listen on 127.0.0.1; Caddy adds HTTPS, Basic auth and a cross-site request guard. The
  Worker reaches them with its own login; your browser reaches them through the admin page (signed, short-lived
  cookies on the tool hostnames). Notices from the box to the Worker are HMAC-signed. Browser conversions read source
  files only from your Worker through signed, 12-hour URLs, so the box holds no storage password.
- **The box's SSH key** on the storage host is limited to rsync inside the media folder (rrsync), where available.
- **Share links** are 128-bit random, reach only their one title, are `noindex`, send no referrer and are rate-limited.
- **Secrets** are Worker secrets (never plain settings), and on the servers in root-only files. Nothing secret is in
  the repository or the generated config.

## The server check

Both installers end with `security-check.sh`, which reports:

- SSH: root login and password login,
- automatic security updates, fail2ban, clock synchronisation,
- what listens on public addresses, and that the watchbox apps listen only locally,
- whether a firewall filters incoming traffic,
- permissions of the watchbox secret files, qBittorrent's web UI binding.

It changes nothing unless asked. `--harden` (installers) or `--fix all-safe` (the script) applies the safe fixes:
SSH keys only (refused unless a working key login exists, so you can't lock yourself out), unattended security
upgrades, fail2ban for SSH, time sync. `--firewall` / `--fix firewall` turns on ufw allowing SSH, 80, 443 and the
torrent port; it's never automatic because other software may depend on your current rules (Docker publishes ports
around ufw, VPNs, panels). On FreeBSD the check only reports. Run it any time:
`sudo sh security-check.sh`.

## Cloudflare

The setup wizard checks your zone's minimum TLS version and "Always Use HTTPS" and recommends TLS 1.2+ and HTTPS
only (`"fix_tls": true` applies it). The Worker has no `workers.dev` or preview URLs. Access apps allow only one-time
PIN, are hidden from the App Launcher and don't accept WARP-based login.

## Reporting a problem

Please open a GitHub security advisory (Security → Report a vulnerability) rather than a public issue.
