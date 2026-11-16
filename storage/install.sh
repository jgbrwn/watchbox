#!/bin/sh
# watchbox storage on a VPS (Debian / Ubuntu): your video files plus the small PHP API the Worker reads them through.
#
#   sudo sh install.sh --domain storage.example.com [--media /srv/watchbox/media] [--box-key "ssh-ed25519 AAAA... box"]
#
# Installs Caddy (HTTPS with an automatic certificate, Basic auth) and PHP-FPM, creates the system user "watchbox"
# who owns the media folders, puts list.php / manage.php / config.php in /var/www/watchbox-storage, and prints the
# values the Cloudflare setup needs (ORIGIN_BASE_URL, ORIGIN_AUTHORIZATION, MANAGE_SECRET).
# --box-key lets the download box copy files in: that key may only run rsync inside the media folder (rrsync).
#
# --harden applies the safe fixes from security-check.sh (SSH keys-only, automatic security updates, fail2ban,
# time sync); --firewall also turns on ufw (allowing SSH, 80, 443 and the torrent port). Without them it only reports.
# Safe to run again (upgrades the PHP files, keeps passwords, keys, config and media). It never touches the
# firewall: open ports 80 and 443 yourself if your provider or ufw blocks them. Shared hosting (DirectAdmin,
# cPanel) doesn't use this script: see docs/storage-shared-hosting.md.
set -eu
HARDEN=0 FIREWALL=0

DOMAIN= MEDIA=/srv/watchbox/media AUTH_USER=watchbox BOX_KEY=
WEB=/var/www/watchbox-storage PRIV=/var/lib/watchbox-storage USER_NAME=watchbox
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --media) MEDIA=${2%/}; shift 2 ;;
    --auth-user) AUTH_USER=$2; shift 2 ;;
    --box-key) BOX_KEY=$2; shift 2 ;;
    --harden) HARDEN=1; shift ;;
    --firewall) FIREWALL=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -n "$DOMAIN" ] || { echo "--domain is required (a name pointing at this server, for the HTTPS certificate)" >&2; exit 2; }
echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "bad --domain" >&2; exit 2; }
echo "$AUTH_USER" | grep -Eq '^[A-Za-z0-9_-]{1,32}$' || { echo "bad --auth-user" >&2; exit 2; }
case "$MEDIA" in /*) ;; *) echo "--media must be an absolute path" >&2; exit 2 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
for f in list.php manage.php; do [ -f "$HERE/$f" ] || { echo "missing $HERE/$f (run from a watchbox checkout)" >&2; exit 1; }; done
. /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in *debian*|*ubuntu*) ;; *) echo "this installer supports Debian and Ubuntu" >&2; exit 1 ;; esac
say() { printf '\n== %s\n' "$*"; }

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy php-fpm php-curl php-mbstring rsync openssl >/dev/null
PHPV=$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')
FPM_SERVICE=php$PHPV-fpm
RRSYNC=$(command -v rrsync || ls /usr/share/doc/rsync/scripts/rrsync 2>/dev/null || true)

say "User and folders"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /bin/sh "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 755 "$MEDIA" "$MEDIA/movies" "$MEDIA/tv" "$MEDIA/youtube"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$PRIV"
install -d -o root -g root -m 755 "$WEB" "$WEB/src"
for r in movies tv youtube; do ln -sfn "$MEDIA/$r" "$WEB/src/$r"; done

say "PHP files"
install -o root -g root -m 644 "$HERE/list.php" "$HERE/manage.php" "$WEB/"
if [ ! -f "$WEB/config.php" ]; then
  cat > "$WEB/config.php" <<EOF
<?php
// Written by install.sh. Root ids must match LIBRARY_ROOTS in the Worker config (the default layout).
return [
  'roots' => ['movies' => '$MEDIA/movies', 'tv' => '$MEDIA/tv', 'youtube' => '$MEDIA/youtube'],
  'base' => '$MEDIA',
  'private_dir' => '$PRIV',
  'usage' => ['type' => 'none'],
];
EOF
  chown root:"$USER_NAME" "$WEB/config.php"; chmod 640 "$WEB/config.php"
fi
[ -s "$PRIV/manage.key" ] || { openssl rand -hex 32 | tr -d '\n' > "$PRIV/manage.key"; }
chown "$USER_NAME:$USER_NAME" "$PRIV/manage.key"; chmod 600 "$PRIV/manage.key"

say "PHP-FPM pool (runs as $USER_NAME)"
cat > "/etc/php/$PHPV/fpm/pool.d/watchbox-storage.conf" <<EOF
[watchbox-storage]
user = $USER_NAME
group = $USER_NAME
listen = /run/php/watchbox-storage.sock
listen.owner = caddy
listen.group = caddy
listen.mode = 0660
pm = ondemand
pm.max_children = 4
pm.process_idle_timeout = 60s
request_terminate_timeout = 900
php_admin_value[open_basedir] = $WEB:$MEDIA:$PRIV:/tmp
php_admin_value[max_execution_time] = 900
php_admin_flag[display_errors] = off
php_admin_flag[log_errors] = on
EOF
systemctl enable -q "$FPM_SERVICE"
systemctl restart "$FPM_SERVICE"

say "Caddy site $DOMAIN"
if [ ! -s "$PRIV/auth" ]; then
  PASS=$(openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-32)
  printf '%s:%s\n' "$AUTH_USER" "$PASS" > "$PRIV/auth"; chmod 600 "$PRIV/auth"
fi
AUTH_USER=$(cut -d: -f1 "$PRIV/auth"); PASS=$(cut -d: -f2- "$PRIV/auth")
HASH=$(caddy hash-password --plaintext "$PASS")
install -d -m 755 /etc/caddy/sites
cat > /etc/caddy/sites/watchbox-storage.caddy <<EOF
# watchbox storage (written by install.sh). Everything needs Basic auth; only these paths exist:
#   GET/HEAD /list.php, POST /manage.php (PHP), GET/HEAD /src/<root>/<file> (the videos, with byte ranges).
$DOMAIN {
	basicauth {
		$AUTH_USER $HASH
	}
	header {
		Cache-Control "private, no-store, no-transform"
		X-Content-Type-Options nosniff
		-Server
	}
	root * $WEB
	@php {
		path /list.php /manage.php
		not {
			path /list.php
			not method GET HEAD
		}
		not {
			path /manage.php
			not method POST
		}
	}
	@media {
		method GET HEAD
		path /src/*
		not path_regexp (^|/)\.
	}
	handle @php {
		php_fastcgi unix//run/php/watchbox-storage.sock
	}
	handle @media {
		file_server
	}
	handle {
		respond 404
	}
}
EOF
CF=/etc/caddy/Caddyfile
[ -f "$CF" ] && cp -p "$CF" "$CF.bak-watchbox-$(date +%Y%m%d%H%M%S)"
if [ ! -f "$CF" ] || grep -q 'The Caddyfile is an easy way' "$CF"; then
  printf '# Sites are in /etc/caddy/sites/ (watchbox).\nimport /etc/caddy/sites/*.caddy\n' > "$CF"   # replaces the package's welcome page
elif ! grep -q 'import /etc/caddy/sites/\*.caddy' "$CF"; then
  printf '\nimport /etc/caddy/sites/*.caddy\n' >> "$CF"
fi
caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1 || { echo "Caddy config invalid:" >&2; caddy validate --config "$CF" --adapter caddyfile >&2; exit 1; }
systemctl enable -q caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

if [ -n "$BOX_KEY" ]; then
  say "Download box key (rsync into $MEDIA only)"
  [ -n "$RRSYNC" ] || { echo "rrsync not found; can't restrict the key" >&2; exit 1; }
  [ -x "$RRSYNC" ] || chmod 755 "$RRSYNC"
  H=$(getent passwd "$USER_NAME" | cut -d: -f6)
  install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$H/.ssh"
  LINE="command=\"$RRSYNC $MEDIA\",restrict $BOX_KEY"
  touch "$H/.ssh/authorized_keys"
  grep -qF "$BOX_KEY" "$H/.ssh/authorized_keys" || echo "$LINE" >> "$H/.ssh/authorized_keys"
  chown "$USER_NAME:$USER_NAME" "$H/.ssh/authorized_keys"; chmod 600 "$H/.ssh/authorized_keys"
fi

say "Check"
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH_USER:$PASS" "https://$DOMAIN/list.php" || true)
  [ "$code" = 200 ] && { ok=1; break; }
  sleep 2
done
[ $ok = 1 ] && echo "https://$DOMAIN/list.php answers (certificate and PHP work)" ||
  echo "WARNING: https://$DOMAIN/list.php didn't answer 200 yet (last: $code). Check DNS for $DOMAIN, ports 80/443, and: journalctl -u caddy -n 50"

say "Security check"
SC="$HERE/../security-check.sh"; [ -f "$SC" ] || SC="$HERE/security-check.sh"
if [ -f "$SC" ]; then
  F=""; [ $HARDEN = 1 ] && F="--fix all-safe"; [ $FIREWALL = 1 ] && F="$F --fix firewall"
  sh "$SC" $F || true
  [ $HARDEN = 1 ] || echo "(apply the safe fixes with --harden; add --firewall to also turn on ufw)"
fi

AUTHZ="Basic $(printf '%s:%s' "$AUTH_USER" "$PASS" | base64 | tr -d '\n')"
cat > "$PRIV/cloudflare-values.txt" <<EOF
ORIGIN_BASE_URL=https://$DOMAIN/
ORIGIN_AUTHORIZATION=$AUTHZ
MANAGE_SECRET=$(cat "$PRIV/manage.key")
LIBRARY_ROOTS=(default: movies, tv, youtube)
STORAGE_SSH=$USER_NAME@$DOMAIN (folders: movies/ tv/ youtube/)
EOF
chmod 600 "$PRIV/cloudflare-values.txt"
say "Done. For the Cloudflare setup (also saved in $PRIV/cloudflare-values.txt, root only):"
cat "$PRIV/cloudflare-values.txt"
