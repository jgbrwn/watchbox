#!/bin/sh
# watchbox download box on FreeBSD 14+. Same result as install.sh (Debian/Ubuntu); modelled on a long-running
# FreeBSD 14.3 box (rc.d services supervised by daemon(8), pkg qBittorrent, Caddy, Deno for yt-dlp).
# STATUS: not yet run on a fresh FreeBSD install; please report problems.
#
#   sh install-freebsd.sh --domain box.example.com --worker https://watch.example.com --storage watchbox@storage.example.com \
#                         [--storage-port 22] [--tmdb-token TOKEN] [--harden]
#
# Options as in install.sh (including --build). Safe to run again. Never touches the firewall (pf/ipfw): open 80/443 yourself if you use one.
set -eu
HARDEN=0 BUILD=
DOMAIN= WORKER= STORAGE= STORAGE_PORT=22 STORAGE_PATH= OMDB= TMDB= U=watchbox
OPT=/usr/local/watchbox PRIV=/var/db/watchbox-box ETC=/usr/local/etc/watchbox RC=/usr/local/etc/rc.d
VUETORRENT_VERSION=2.36.1
VUETORRENT_SHA256=70b67531f0f3bc36c8bd05d82cc7ba1ee37c71c17f0b6c45f522200e35e66f37
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --worker) WORKER=${2%/}; shift 2 ;;
    --storage) STORAGE=$2; shift 2 ;;
    --storage-port) STORAGE_PORT=$2; shift 2 ;;
    --storage-path) STORAGE_PATH=${2%/}; shift 2 ;;
    --tmdb-token|--tmdb-key) TMDB=$2; shift 2 ;;
    --omdb-key) OMDB=$2; shift 2 ;;
    --harden) HARDEN=1; shift ;;
    --build) BUILD=--build; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ "$(uname -s)" = FreeBSD ] || { echo "this is the FreeBSD installer (Debian/Ubuntu: install.sh)" >&2; exit 1; }
[ -n "$DOMAIN" ] && [ -n "$WORKER" ] && [ -n "$STORAGE" ] || { echo "--domain, --worker and --storage are required" >&2; exit 2; }
echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "bad --domain" >&2; exit 2; }
echo "$WORKER" | grep -Eq '^https://[A-Za-z0-9.-]+$' || { echo "--worker must look like https://watch.example.com" >&2; exit 2; }
echo "$STORAGE" | grep -Eq '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$' || { echo "--storage must look like user@host" >&2; exit 2; }
SP=${STORAGE_PATH:+$STORAGE_PATH/}   # rsync paths on the storage server: relative to the rrsync folder, or under --storage-path
echo "$STORAGE_PORT" | grep -Eq '^[0-9]{1,5}$' || { echo "bad --storage-port" >&2; exit 2; }
WORKER_HOST=${WORKER#https://}
HERE=$(cd "$(dirname "$0")" && pwd)
case "$(uname -m)" in amd64) ARCH=amd64 ;; arm64|aarch64) ARCH=arm64 ;; *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
BIN="$HERE/bin/freebsd-$ARCH"
say() { printf '\n== %s\n' "$*"; }
H=/home/$U

say "Packages"
env ASSUME_ALWAYS_YES=yes pkg install -q caddy qbittorrent-nox ffmpeg rsync deno python3 expat curl >/dev/null
PYV=$(python3 -c 'import sys; print("%d%d" % sys.version_info[:2])')
env ASSUME_ALWAYS_YES=yes pkg install -q "py$PYV-sqlite3" >/dev/null || true

say "Programs (watch-stream, c-cli-web, rsync-web)"
[ -z "$BUILD" ] || env ASSUME_ALWAYS_YES=yes pkg install -q git-lite >/dev/null
sh "$HERE/get-binaries.sh" freebsd "$ARCH" $BUILD

say "User, folders, programs"
id "$U" >/dev/null 2>&1 || pw useradd "$U" -m -d "$H" -s /bin/sh -c "watchbox"
install -d -o "$U" -g "$U" -m 755 "$H/media" "$H/media/temp"
install -d -o "$U" -g "$U" -m 700 "$H/.ssh" "$H/.config" "$H/.config/qBittorrent"
install -d -m 755 "$OPT" "$OPT/bin" "$ETC"
install -d -m 700 "$PRIV"
for b in watch-stream c-cli-web rsync-web; do install -m 755 "$BIN/$b" "$OPT/bin/$b"; done
install -m 755 "$HERE/watch-torrent-done" "$OPT/bin/watch-torrent-done"

say "VueTorrent $VUETORRENT_VERSION"
if [ ! -f "$OPT/vuetorrent-$VUETORRENT_VERSION/public/index.html" ]; then
  tmp=$(mktemp -d)
  fetch -q -o "$tmp/v.zip" "https://github.com/VueTorrent/VueTorrent/releases/download/v$VUETORRENT_VERSION/vuetorrent.zip"
  [ "$(sha256 -q "$tmp/v.zip")" = "$VUETORRENT_SHA256" ] || { echo "VueTorrent checksum mismatch" >&2; exit 1; }
  install -d "$OPT/vuetorrent-$VUETORRENT_VERSION"
  unzip -q "$tmp/v.zip" -d "$tmp/u"
  cp -R "$tmp/u/vuetorrent/." "$OPT/vuetorrent-$VUETORRENT_VERSION/"
  chmod -R a-w "$OPT/vuetorrent-$VUETORRENT_VERSION"
  rm -rf "$tmp"
fi
ln -sfn "$OPT/vuetorrent-$VUETORRENT_VERSION" "$OPT/vuetorrent"

say "yt-dlp"
if [ ! -x "$H/.yt-dlp/bin/python" ]; then
  su -m "$U" -c "python3 -m venv --without-pip $H/.yt-dlp && $H/.yt-dlp/bin/python -m ensurepip >/dev/null"
fi
su -m "$U" -c "HOME=$H $H/.yt-dlp/bin/python -m pip install -q -U pip 'yt-dlp[default]'"

say "Secrets"
gen() { [ -s "$PRIV/$1" ] || { openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-32 > "$PRIV/$1"; chmod 600 "$PRIV/$1"; }; cat "$PRIV/$1"; }
OWNER_PASS=$(gen owner-password); WORKER_PASS=$(gen worker-password); HOOK_SECRET=$(gen webhook-secret)
printf 'WATCH_HOOK_URL=%s/hooks/qbit\nWATCH_HOOK_SECRET=%s\n' "$WORKER" "$HOOK_SECRET" > "$H/.config/watch-hook.env"
chown "$U:$U" "$H/.config/watch-hook.env"; chmod 600 "$H/.config/watch-hook.env"
printf 'RSYNC_WEB_WEBHOOK_SECRET=%s\n' "$HOOK_SECRET" > "$ETC/rsync-web.env"
[ -f "$ETC/c-cli-web.env" ] || : > "$ETC/c-cli-web.env"
if [ -n "$TMDB$OMDB" ]; then   # c-cli's posters and ratings: TMDB (same token as the Worker) or OMDb; kept on re-runs without them
  { [ -z "$TMDB" ] || printf 'TMDB_API_KEY=%s\n' "$TMDB"; [ -z "$OMDB" ] || printf 'OMDB_API_KEY=%s\n' "$OMDB"; } > "$ETC/c-cli-web.env"
fi
chmod 600 "$ETC/rsync-web.env" "$ETC/c-cli-web.env"

say "SSH key for $STORAGE"
[ -f "$H/.ssh/id_ed25519" ] || su -m "$U" -c "ssh-keygen -q -t ed25519 -N '' -C 'watchbox box $DOMAIN' -f $H/.ssh/id_ed25519"
SHOST=${STORAGE#*@}; SUSER=${STORAGE%@*}
cat > "$H/.ssh/config" <<EOF
# Written by watchbox install-freebsd.sh. "storage:" in rsync destinations means the storage server.
Host storage
	HostName $SHOST
	User $SUSER
	Port $STORAGE_PORT
	IdentityFile ~/.ssh/id_ed25519
	IdentitiesOnly yes
	ServerAliveInterval 30
	ServerAliveCountMax 6
EOF
chown "$U:$U" "$H/.ssh/config"; chmod 600 "$H/.ssh/config"
ssh-keyscan -p "$STORAGE_PORT" -T 10 "$SHOST" 2>/dev/null | sort -u > "$H/.ssh/known_hosts.new" || true
if [ -s "$H/.ssh/known_hosts.new" ]; then mv "$H/.ssh/known_hosts.new" "$H/.ssh/known_hosts"; chown "$U:$U" "$H/.ssh/known_hosts"
else rm -f "$H/.ssh/known_hosts.new"; echo "could not read the storage server's key (is it up?)" >&2; fi

say "qBittorrent"
QB=$H/.config/qBittorrent
if [ ! -f "$QB/qBittorrent.conf" ]; then
  PORT=$(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 20000 + 40000 ))
  cat > "$QB/qBittorrent.conf" <<'EOF'
[AutoRun]
enabled=true
program=@OPT@/bin/watch-torrent-done \"%I\"
OnTorrentAdded\Enabled=true
OnTorrentAdded\Program=@OPT@/bin/watch-torrent-done \"%I\" added

[BitTorrent]
Session\DefaultSavePath=@H@/media
Session\Port=@PORT@
Session\QueueingSystemEnabled=false
Session\TempPath=@H@/media/temp
Session\TempPathEnabled=true

[Core]
AutoDeleteAddedTorrentFile=IfAdded

[LegalNotice]
Accepted=true

[Preferences]
Connection\UPnP=false
WebUI\Address=127.0.0.1
WebUI\Port=8080
WebUI\LocalHostAuth=false
WebUI\CSRFProtection=true
WebUI\ClickjackingProtection=true
WebUI\HostHeaderValidation=true
WebUI\ReverseProxySupportEnabled=false
WebUI\AlternativeUIEnabled=true
WebUI\RootFolder=@OPT@/vuetorrent
EOF
  sed -i '' "s|@OPT@|$OPT|g; s|@H@|$H|g; s|@PORT@|$PORT|g" "$QB/qBittorrent.conf"
  printf '{\n    "%s": { "add_torrent_params": { "save_path": "" }, "recursive": false }\n}\n' "$H" > "$QB/watched_folders.json"
  chown -R "$U:$U" "$QB"
fi
# The package's rc script, run as watchbox with its HOME (settings above); its own folder options left empty.
sysrc -q qbittorrent_enable=YES qbittorrent_user="$U" qbittorrent_group="$U" qbittorrent_env="HOME=$H" qbittorrent_conf_dir= qbittorrent_download_dir= >/dev/null

say "Services"
rcscript() {   # name, description, program + arguments, env file (optional)
  cat > "$RC/$1" <<EOF
#!/bin/sh
# PROVIDE: $1
# REQUIRE: LOGIN NETWORKING
# KEYWORD: shutdown
#
# watchbox: $2. Supervised by daemon(8) (restarted if it exits). Log: /var/log/$1.log

. /etc/rc.subr

name=$1
rcvar=$1_enable
load_rc_config \$name

: \${$1_enable:=NO}
${4:+: \${$1_env_file:=$4\}}

pidfile="/var/run/\${name}.pid"
procname="/usr/sbin/daemon"
command="/usr/sbin/daemon"
command_args="-r -R 5 -T \${name} -o /var/log/\${name}.log -u $U -P \${pidfile} $3"
$1_chdir="$H"
$1_env="HOME=$H USER=$U PATH=/sbin:/bin:/usr/sbin:/usr/bin:/usr/local/sbin:/usr/local/bin${5:+ $5}"

run_rc_command "\$1"
EOF
  chmod 555 "$RC/$1"
}
rcscript watchbox_ccli "c-cli web, find torrents (127.0.0.1:8000)" "$OPT/bin/c-cli-web" "$ETC/c-cli-web.env" "HOST=127.0.0.1 PORT=8000 DOWNLOAD_DIR=$H"
rcscript watchbox_rsyncweb "rsync-web, copies to storage (127.0.0.1:8888)" \
  "$OPT/bin/rsync-web -listen 127.0.0.1:8888 -dir $H -preset Movies=storage:${SP}movies/ -preset TV=storage:${SP}tv/ -push-root media -webhook $WORKER/hooks/rsync" "$ETC/rsync-web.env"
rcscript watchbox_stream "watch-stream, browser conversions and YouTube (127.0.0.1:8891)" \
  "/usr/bin/nice -n 5 $OPT/bin/watch-stream -listen 127.0.0.1:8891 -src-host $WORKER_HOST -yt-dest storage:${SP}youtube/ -yt-tv-dest storage:${SP}tv/ -yt-js-runtime deno"
for s in qbittorrent watchbox_ccli watchbox_rsyncweb watchbox_stream; do
  sysrc -q "${s}_enable=YES" >/dev/null
  service "$s" restart >/dev/null 2>&1 || service "$s" start >/dev/null 2>&1 || true
done
install -d /usr/local/etc/newsyslog.conf.d
cat > /usr/local/etc/newsyslog.conf.d/watchbox.conf <<'EOF'
/var/log/watchbox_ccli.log      644  5  1000  *  JC
/var/log/watchbox_rsyncweb.log  644  5  1000  *  JC
/var/log/watchbox_stream.log    644  5  1000  *  JC
EOF

say "Caddy sites cc/dl/rs.$DOMAIN"
OWNER_HASH=$(caddy hash-password --plaintext "$OWNER_PASS"); WORKER_HASH=$(caddy hash-password --plaintext "$WORKER_PASS")
CDIR=/usr/local/etc/caddy
install -d -m 755 "$CDIR/sites"
site() {
  cat <<EOF

$1.$DOMAIN {
	import watchbox_box_guard
	basic_auth {
		watchworker $WORKER_HASH
		owner $OWNER_HASH
	}
$3
	reverse_proxy $2
}
EOF
}
{
  cat <<'EOF'
# watchbox download box (written by install-freebsd.sh). Users: "owner" (you) and "watchworker" (the Worker).
(watchbox_box_guard) {
	@xsite {
		header Sec-Fetch-Site cross-site
		not {
			method GET HEAD
			header Sec-Fetch-Mode navigate
		}
	}
	respond @xsite "Cross-site request blocked" 403
}
EOF
  site cc 127.0.0.1:8000 ""
  site dl 127.0.0.1:8080 "	handle_path /__watchstream/* {
		reverse_proxy 127.0.0.1:8891
	}"
  site rs 127.0.0.1:8888 ""
} > "$CDIR/sites/watchbox-box.caddy"
CF=$CDIR/Caddyfile
[ -f "$CF" ] && cp -p "$CF" "$CF.bak-watchbox-$(date +%Y%m%d%H%M%S)"
if [ ! -f "$CF" ] || grep -q 'The Caddyfile is an easy way' "$CF"; then
  printf '# Sites are in %s/sites/ (watchbox).\nimport %s/sites/*.caddy\n' "$CDIR" "$CDIR" > "$CF"
elif ! grep -q "import $CDIR/sites/\*.caddy" "$CF"; then
  printf '\nimport %s/sites/*.caddy\n' "$CDIR" >> "$CF"
fi
caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1 || { echo "Caddy config invalid:" >&2; caddy validate --config "$CF" --adapter caddyfile >&2; exit 1; }
sysrc -q caddy_enable=YES >/dev/null
service caddy reload >/dev/null 2>&1 || service caddy restart >/dev/null 2>&1 || service caddy start

say "Check"
sleep 3
for s in qbittorrent watchbox_ccli watchbox_rsyncweb watchbox_stream; do printf '%-18s %s\n' "$s" "$(service "$s" status >/dev/null 2>&1 && echo running || echo 'NOT running')"; done
for t in cc dl rs; do
  code=000
  for i in $(seq 1 20); do code=$(curl -s -o /dev/null -w '%{http_code}' -u "owner:$OWNER_PASS" "https://$t.$DOMAIN/" || true); [ "$code" = 200 ] && break; sleep 2; done
  printf 'https://%s.%s/  %s\n' "$t" "$DOMAIN" "$([ "$code" = 200 ] && echo ok || echo "not answering yet ($code): check DNS and ports 80/443")"
done
su -m "$U" -c "HOME=$H rsync --list-only -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' storage:" >/dev/null 2>&1 &&
  echo "storage: reachable" || echo "storage: not reachable yet (add this box's key to the storage server, below)"

say "Security check"
SC="$HERE/../security-check.sh"
[ -f "$SC" ] && { sh "$SC" || true; [ $HARDEN = 1 ] && echo "(on FreeBSD the check only reports; apply its advice by hand)"; }

AUTHZ="Basic $(printf 'watchworker:%s' "$WORKER_PASS" | openssl base64 -A)"
cat > "$PRIV/cloudflare-values.txt" <<EOF
TOOLS={"cc":{"label":"Find","name":"c-cli","host":"<watch-cc host on your Worker domain>","upstream":"https://cc.$DOMAIN","service":"watchbox_ccli"},"dl":{"label":"Downloads","name":"qBittorrent (VueTorrent)","host":"<watch-dl host>","upstream":"https://dl.$DOMAIN","service":"qbittorrent"},"rs":{"label":"Transfer","name":"rsync-web","host":"<watch-rs host>","upstream":"https://rs.$DOMAIN","service":"watchbox_rsyncweb"}}
TOOLS_AUTHORIZATION=$AUTHZ
RSYNC_WEBHOOK_SECRET=$HOOK_SECRET
BOX_MEDIA_PATH=$H/media/
EOF
chmod 600 "$PRIV/cloudflare-values.txt"
say "Done"
echo "Your login for https://cc|dl|rs.$DOMAIN: owner / $OWNER_PASS   (saved in $PRIV/owner-password)"
echo
echo "This box's key, for the storage installer (--box-key):"
cat "$H/.ssh/id_ed25519.pub"
echo
echo "For the Cloudflare setup (also in $PRIV/cloudflare-values.txt, root only):"
cat "$PRIV/cloudflare-values.txt"
