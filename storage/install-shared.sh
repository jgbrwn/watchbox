#!/bin/sh
# watchbox storage on shared hosting (DirectAdmin, cPanel, or any host with PHP 8, Apache/LiteSpeed and SSH).
# Run it over SSH as your normal hosting user (no root needed), from an unpacked watchbox release:
#
#   sh install-shared.sh --web-dir ~/domains/storage.example.com/public_html --media-dir ~/media \
#        --domain storage.example.com [--panel directadmin|cpanel --panel-url https://panel.example.com:2222]
#        [--box-key "ssh-ed25519 AAAA... watchbox box"]
#
#   --web-dir    the folder your storage (sub)domain serves; create the subdomain in your panel first, with HTTPS
#   --media-dir  where the videos live; movies/ tv/ youtube/ are created inside (may already hold your files)
#   --panel      for the disk-usage meter: the login key / API token goes into the private folder (see the docs)
#   --box-key    lets the download box copy files in with rsync (restricted to rsync with rrsync when available)
#
# Writes list.php, manage.php, config.php, the src/<folder> links and a password file (outside the web folder),
# and .htaccess (or .htaccess.watchbox next to an existing one, for you to merge). Safe to run again.
set -eu
WEB= MEDIA= DOMAIN= PANEL=none PANEL_URL= PRIV="$HOME/watchbox-private" BOX_KEY= AUTH_USER=watchbox
while [ $# -gt 0 ]; do
  case "$1" in
    --web-dir) WEB=${2%/}; shift 2 ;;
    --media-dir) MEDIA=${2%/}; shift 2 ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --private-dir) PRIV=${2%/}; shift 2 ;;
    --panel) PANEL=$2; shift 2 ;;
    --panel-url) PANEL_URL=${2%/}; shift 2 ;;
    --box-key) BOX_KEY=$2; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$WEB" ] && [ -n "$MEDIA" ] && [ -n "$DOMAIN" ] || { echo "--web-dir, --media-dir and --domain are required (see --help)" >&2; exit 2; }
[ -d "$WEB" ] || { echo "$WEB doesn't exist: create the storage subdomain in your panel first" >&2; exit 1; }
case "$PANEL" in none|directadmin|cpanel) ;; *) echo "--panel must be none, directadmin or cpanel" >&2; exit 2 ;; esac
[ "$PANEL" = none ] || [ -n "$PANEL_URL" ] || { echo "--panel-url is required with --panel $PANEL" >&2; exit 2; }
command -v php >/dev/null || { echo "php isn't available on the command line here" >&2; exit 1; }
php -r 'exit(PHP_MAJOR_VERSION >= 8 ? 0 : 1);' || { echo "PHP 8 or newer is needed" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
WEB=$(cd "$WEB" && pwd)
mkdir -p "$MEDIA" && MEDIA=$(cd "$MEDIA" && pwd)
case "$PRIV/" in "$WEB"/*) echo "--private-dir must be outside the web folder" >&2; exit 2 ;; esac
say() { printf '\n== %s\n' "$*"; }

say "Folders"
umask 022
mkdir -p "$MEDIA/movies" "$MEDIA/tv" "$MEDIA/youtube" "$WEB/src"
for r in movies tv youtube; do ln -sfn "$MEDIA/$r" "$WEB/src/$r"; done
mkdir -p "$PRIV" && chmod 711 "$PRIV"   # the web server must reach htpasswd; nothing can be listed

say "PHP files"
cp "$HERE/list.php" "$HERE/manage.php" "$WEB/" && chmod 644 "$WEB/list.php" "$WEB/manage.php"
q() { php -r 'echo var_export($argv[1], true);' "$1"; }   # a PHP string literal
if [ ! -f "$WEB/config.php" ]; then
  case "$PANEL" in
    none) USAGE="['type' => 'none']" ;;
    directadmin) USAGE="['type' => 'directadmin', 'url' => $(q "$PANEL_URL"), 'user' => $(q "$(id -un)"), 'key_file' => 'da-usage.key']" ;;
    cpanel) USAGE="['type' => 'cpanel', 'url' => $(q "$PANEL_URL"), 'user' => $(q "$(id -un)"), 'token_file' => 'cpanel.token']" ;;
  esac
  cat > "$WEB/config.php" <<EOF
<?php
// Written by install-shared.sh. Root ids must match LIBRARY_ROOTS in the Worker config (the default layout).
return [
  'roots' => ['movies' => $(q "$MEDIA/movies"), 'tv' => $(q "$MEDIA/tv"), 'youtube' => $(q "$MEDIA/youtube")],
  'base' => $(q "$MEDIA"),
  'private_dir' => $(q "$PRIV"),
  'usage' => $USAGE,
];
EOF
  chmod 600 "$WEB/config.php"
fi
php -l "$WEB/config.php" >/dev/null

say "Keys and password"
[ -s "$PRIV/manage.key" ] || php -r 'echo bin2hex(random_bytes(32));' > "$PRIV/manage.key"
chmod 600 "$PRIV/manage.key"
if [ ! -s "$PRIV/auth" ]; then
  PASS=$(php -r 'echo substr(strtr(base64_encode(random_bytes(30)), "+/=", "xyz"), 0, 32);')
  printf '%s:%s\n' "$AUTH_USER" "$PASS" > "$PRIV/auth"
fi
chmod 600 "$PRIV/auth"
AUTH_USER=$(cut -d: -f1 "$PRIV/auth"); PASS=$(cut -d: -f2- "$PRIV/auth")
php -r 'echo $argv[1], ":", password_hash($argv[2], PASSWORD_BCRYPT), "\n";' "$AUTH_USER" "$PASS" > "$PRIV/htpasswd"
chmod 644 "$PRIV/htpasswd"   # the web server reads it; the hash is bcrypt

say ".htaccess"
HT="$WEB/.htaccess"
sed "s|/home/USER/watchbox-private/htpasswd|$PRIV/htpasswd|" "$HERE/htaccess.example" > "$WEB/.htaccess.watchbox"
if [ ! -f "$HT" ] || grep -q 'watchbox storage' "$HT"; then mv "$WEB/.htaccess.watchbox" "$HT"; echo "  wrote $HT"
else echo "  $HT already exists (from your panel?): merge $WEB/.htaccess.watchbox into it, then delete that file"; fi
chmod 644 "$HT" 2>/dev/null || true

if [ -n "$BOX_KEY" ]; then
  say "Download box key"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
  if grep -qF "$BOX_KEY" "$HOME/.ssh/authorized_keys"; then echo "  already there"
  elif RR=$(command -v rrsync); then echo "command=\"$RR $MEDIA\",restrict $BOX_KEY" >> "$HOME/.ssh/authorized_keys"; echo "  added (may only rsync inside $MEDIA)"
  else
    echo "restrict $BOX_KEY" >> "$HOME/.ssh/authorized_keys"
    echo "  added. rrsync isn't installed here, so the key can't be limited to rsync: it can log in as $(id -un)."
    echo "  On the box, use destinations under $MEDIA (installers: --storage-path $MEDIA)."
  fi
fi

say "Check"
php -r '$_GET=["space"=>"1"]; include $argv[1];' "$WEB/list.php" >/dev/null 2>&1 && echo "  disk usage: works" || echo "  disk usage: not working yet (panel key/token missing?); the meter falls back to an estimate"
out=$(cd "$WEB" && php -r 'include "list.php";' 2>&1 | head -c 300)
case "$out" in *'"roots"'*) echo "  listing: works" ;; *) echo "  listing failed: $out" ;; esac
if command -v curl >/dev/null; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH_USER:$PASS" "https://$DOMAIN/list.php" || true)
  [ "$code" = 200 ] && echo "  https://$DOMAIN/list.php: ok" || echo "  https://$DOMAIN/list.php: HTTP $code (check the subdomain's HTTPS and .htaccess)"
  noauth=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/list.php" || true)
  [ "$noauth" = 401 ] && echo "  without the password: refused (good)" || echo "  WARNING: without the password it answers $noauth; the .htaccess isn't active"
fi

AUTHZ="Basic $(printf '%s:%s' "$AUTH_USER" "$PASS" | base64 | tr -d '\n')"
cat > "$PRIV/cloudflare-values.txt" <<EOF
ORIGIN_BASE_URL=https://$DOMAIN/
ORIGIN_AUTHORIZATION=$AUTHZ
MANAGE_SECRET=$(cat "$PRIV/manage.key")
STORAGE_SSH=$(id -un)@<this host> (folders under $MEDIA: movies/ tv/ youtube/)
EOF
chmod 600 "$PRIV/cloudflare-values.txt"
say "Done. For the Cloudflare setup (also saved in $PRIV/cloudflare-values.txt):"
cat "$PRIV/cloudflare-values.txt"
