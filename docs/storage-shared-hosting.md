# Storage on shared hosting (DirectAdmin, cPanel)

Shared hosting with lots of disk is the cheapest place for a video library. You need PHP 8 (any web server that reads
`.htaccess`: Apache or LiteSpeed), SSH access, and a (sub)domain with HTTPS.

## 1. Create the storage subdomain

In your panel, add a subdomain such as `storage.example.com` and turn on HTTPS (Let's Encrypt) for it. Note the folder
it serves, e.g. `~/domains/storage.example.com/public_html` (DirectAdmin) or `~/storage.example.com` (cPanel).
Use a subdomain only for watchbox: the installer writes its `.htaccess`, which locks the whole folder behind a password.

## 2. Run the installer over SSH

Upload the release (or `git clone`) to your account and run, as your normal user:

```sh
sh storage/install-shared.sh --web-dir ~/domains/storage.example.com/public_html \
   --media-dir ~/media --domain storage.example.com \
   [--panel directadmin --panel-url https://your-panel-host:2222]      # or: --panel cpanel --panel-url https://host:2083
```

It creates `~/media/{movies,tv,youtube}` (or uses them if they exist), links them as `src/movies` etc. in the web
folder, writes `list.php`, `manage.php`, `config.php` (mode 600) and `.htaccess`, and keeps the password file, the
signing key and settings in `~/watchbox-private` (outside the web folder). If the folder already has an `.htaccess`
it writes `.htaccess.watchbox` next to it for you to merge. It checks the result over HTTPS (including that it
refuses requests without the password) and prints the values for the Cloudflare setup. Run it again to upgrade.

**Your existing library:** point `--media-dir` at the folder that holds your `movies` and `tv` folders. If your
layout is different (other names, several folders, movies in two places), edit `config.php`'s `roots` and set the same
ids in `LIBRARY_ROOTS` in the Worker config; see [Architecture → Folders](architecture.md#folders-library-roots).

## 3. The disk-usage meter (optional)

The admin page shows how full your plan is. Shared hosts don't let PHP see the quota directly, so it asks the panel:

- **DirectAdmin:** create a login key that can only read usage. Panel → *Login Keys* → *Create Key*: name
  `watchbox-usage`, *Allowed Commands*: only `CMD_API_SHOW_USER_USAGE`, *Allowed IPs*: your server's own IP (the PHP
  calls the panel from there), no expiry. Save the key text into `~/watchbox-private/da-usage.key` (`chmod 600`).
  Set `STORAGE_QUOTA_MB` in the Worker config to your plan size in MB (DirectAdmin's "8 TB" plan is 8388608).
- **cPanel:** *Security → Manage API Tokens* → create a token (restrict it to your server's IP if offered), save it
  into `~/watchbox-private/cpanel.token` (`chmod 600`). cPanel reports the quota itself.
- Without either, the meter estimates usage from the library's file sizes plus `STORAGE_OTHER_MB`.

## 4. The download box's key

Give the box's public key to the installer (`--box-key "ssh-ed25519 …"`). If the host has `rrsync`, the key may only
copy files with rsync inside your media folder. Many shared hosts don't have it: then the key can log in as your user
(it's added with `restrict`, so no port forwarding or terminal), and you install the box with
`--storage-path /home/you/media` so it copies to the right place.

## HostBRR

HostBRR's storage plans (DirectAdmin, large disks, SSH on a custom port) work well and are what watchbox was built on:

- Panel: DirectAdmin (the address and SSH port are in your welcome email); use it for the subdomain, Let's Encrypt and the
  login key (step 3).
- Web folders are `~/domains/<domain>/public_html`; keep media outside them, e.g. `~/media` or a folder under your
  storage domain's `data/` directory.
- PHP needs a `User-Agent` header on requests (the Worker always sends one), otherwise the firewall answers 403.
- `rrsync` isn't installed: use `--storage-path` on the box (step 4).
- YouTube tends to trust HostBRR's IPs more than many VPS providers'; see
  [Download box → YouTube](download-box.md#youtube) for sending the box's YouTube traffic through your storage host.
