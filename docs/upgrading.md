# Upgrading

Releases are tagged `vX.Y.Z`; read the release notes first (they say if a part needs re-running). Your data stays:
the database is migrated forward, and the installers keep passwords, keys, settings and media.

1. **Cloudflare:** in your checkout (`git pull` or unpack the new release, keep `worker/wrangler.<name>.jsonc` and
   your answers file), run `cd worker && npm install && npm run setup -- --answers my-answers.json`. It applies new
   database migrations, redeploys and leaves everything else as it was. (By hand:
   `npx wrangler d1 migrations apply <db> --remote --config wrangler.<name>.jsonc` then
   `npx wrangler deploy --config wrangler.<name>.jsonc`.)
2. **Storage:** re-run the installer you used (`storage/install.sh --domain …` or `storage/install-shared.sh …` with
   the same options). It replaces `list.php` and `manage.php`; `config.php`, `.htaccess` (if it wrote it), the password
   and the key stay.
3. **Download box:** re-run `box/install.sh` (or `install-freebsd.sh`) with the same options from the new bundle or
   pulled clone (a clone fetches the newest release's programs when there's a newer one; with `--build` it
   recompiles). It replaces the programs and restarts the services; qBittorrent's settings, downloads, passwords and keys stay. yt-dlp also updates
   itself daily.

Order: Cloudflare first is fine; the Worker stays compatible with the previous storage and box versions within a
major version.

Rolling back the Worker: `npx wrangler rollback --config wrangler.<name>.jsonc` (database migrations only add, so an
older Worker keeps working on a newer database within a major version).
