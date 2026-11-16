# Storage on a VPS (Debian / Ubuntu)

Any Debian 12+/Ubuntu 22.04+ server with enough disk for your videos. One command installs Caddy (automatic HTTPS) and
PHP-FPM and sets everything up:

```sh
sudo sh storage/install.sh --domain storage.example.com [--media /srv/watchbox/media] [--harden] [--firewall]
```

Before running it, point `storage.example.com` (an A/AAAA record, **not** proxied through Cloudflare's orange cloud)
at the server, and make sure ports 80 and 443 are reachable (Caddy gets a Let's Encrypt certificate).

What it does:

- creates the system user `watchbox`, who owns `/srv/watchbox/media/{movies,tv,youtube}`,
- installs `list.php`, `manage.php` and a generated `config.php` in `/var/www/watchbox-storage`, served by a PHP-FPM
  pool running as `watchbox` (so the trash can move files),
- configures Caddy for your domain with Basic auth: only `GET /list.php`, `POST /manage.php` and `GET/HEAD /src/…`
  (the videos, with byte ranges) exist; dotfiles, `config.php` and `../` paths are refused,
- generates the password and the signing key for `manage.php` in `/var/lib/watchbox-storage` (root only),
- runs the [security check](security.md) (and applies its safe fixes with `--harden`; `--firewall` turns on ufw),
- prints `ORIGIN_BASE_URL`, `ORIGIN_AUTHORIZATION` and `MANAGE_SECRET` for the Cloudflare setup (also saved in
  `/var/lib/watchbox-storage/cloudflare-values.txt`).

It never deletes anything, keeps the password, key and config when run again (to upgrade the PHP files), and never
changes the firewall unless you pass `--firewall`.

## Adding your videos

Copy files into `/srv/watchbox/media/movies` and `/tv` (any layout the [naming guide](using.md#naming-files) covers),
owned by `watchbox` (`chown -R watchbox: /srv/watchbox/media`). The next sync (within 15 minutes, or *Sync now* on the
admin page) picks them up.

## The download box's key

After installing the download box, re-run the storage installer with its key:

```sh
sudo sh storage/install.sh --domain storage.example.com --box-key "ssh-ed25519 AAAA… watchbox box box.example.com"
```

The key is added for the `watchbox` user with `command="rrsync /srv/watchbox/media",restrict`: it can only copy files
with rsync inside the media folder, nothing else (no shell, no other paths).

## One server for everything

Storage and download box can share one VPS: run both installers with their own domains (e.g. `storage.example.com` and
`box.example.com`), and give the box `--storage watchbox@storage.example.com` (it copies to itself over SSH).
This works only with VPS storage: shared hosting (DirectAdmin, cPanel, HostBRR) can't run the download box, which
needs root and long-running services, so there the box is always a second machine.
