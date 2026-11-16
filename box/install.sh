#!/bin/sh
# watchbox download box (Debian / Ubuntu): find and download torrents, copy finished downloads to your storage,
# YouTube downloads, and browser-playback conversions. Everything sits behind Caddy (HTTPS + Basic auth); the apps
# themselves only listen on 127.0.0.1.
#
#   sudo sh install.sh --domain box.example.com --worker https://watch.example.com \
#                      --storage watchbox@storage.example.com [--storage-port 22] [--omdb-key KEY]
#
#   --domain   base name: the tools get cc.<domain> (find), dl.<domain> (downloads + conversions), rs.<domain>
#              (transfers); point all three at this server
#   --worker   your watchbox address (finished-download and YouTube notices go there; conversions only read from it)
#   --storage  user@host of the storage server; files are copied into its movies/ tv/ youtube/ folders with rsync
#   --storage-path  only if the storage server can't restrict the box's key with rrsync: the media folder there
#
# Run from an unpacked watchbox release (bin/linux-<arch>/ holds watch-stream, c-cli-web, rsync-web).
# --harden applies the safe fixes from security-check.sh (SSH keys-only, automatic security updates, fail2ban,
# time sync); --firewall also turns on ufw (allowing SSH, 80, 443 and the torrent port). Without them it only reports.
# Safe to run again (keeps passwords, keys and qBittorrent's settings). Never touches the firewall.
# Prints this box's SSH key (give it to the storage installer: --box-key) and the values the Cloudflare setup needs.
set -eu
HARDEN=0 FIREWALL=0

DOMAIN= WORKER= STORAGE= STORAGE_PORT=22 STORAGE_PATH= OMDB= U=watchbox
OPT=/opt/watchbox PRIV=/var/lib/watchbox-box ETC=/etc/watchbox
VUETORRENT_VERSION=2.36.1
VUETORRENT_SHA256=70b67531f0f3bc36c8bd05d82cc7ba1ee37c71c17f0b6c45f522200e35e66f37
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --worker) WORKER=${2%/}; shift 2 ;;
    --storage) STORAGE=$2; shift 2 ;;
    --storage-port) STORAGE_PORT=$2; shift 2 ;;
    --storage-path) STORAGE_PATH=${2%/}; shift 2 ;;
    --omdb-key) OMDB=$2; shift 2 ;;
    --harden) HARDEN=1; shift ;;
    --firewall) FIREWALL=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -n "$DOMAIN" ] && [ -n "$WORKER" ] && [ -n "$STORAGE" ] || { echo "--domain, --worker and --storage are required (see --help)" >&2; exit 2; }
echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "bad --domain" >&2; exit 2; }
echo "$WORKER" | grep -Eq '^https://[A-Za-z0-9.-]+$' || { echo "--worker must look like https://watch.example.com" >&2; exit 2; }
echo "$STORAGE" | grep -Eq '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$' || { echo "--storage must look like user@host" >&2; exit 2; }
SP=${STORAGE_PATH:+$STORAGE_PATH/}   # rsync paths on the storage server: relative to the rrsync folder, or under --storage-path
echo "$STORAGE_PORT" | grep -Eq '^[0-9]{1,5}$' || { echo "bad --storage-port" >&2; exit 2; }
WORKER_HOST=${WORKER#https://}
HERE=$(cd "$(dirname "$0")" && pwd)
. /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in *debian*|*ubuntu*) ;; *) echo "this installer supports Debian and Ubuntu (FreeBSD: install-freebsd.sh)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
BIN="$HERE/bin/linux-$ARCH"
for b in watch-stream c-cli-web rsync-web; do [ -x "$BIN/$b" ] || { echo "missing $BIN/$b (run from an unpacked watchbox release)" >&2; exit 1; }; done
say() { printf '\n== %s\n' "$*"; }
H=/home/$U

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy qbittorrent-nox ffmpeg python3-venv nodejs rsync openssh-client curl unzip openssl >/dev/null

say "User, folders, programs"
id "$U" >/dev/null 2>&1 || useradd --create-home --home-dir "$H" --shell /bin/sh "$U"
install -d -o "$U" -g "$U" -m 755 "$H/media" "$H/media/temp"
install -d -o "$U" -g "$U" -m 700 "$H/.ssh" "$H/.config" "$H/.config/qBittorrent"
install -d -m 755 "$OPT" "$OPT/bin" "$ETC"
install -d -m 700 "$PRIV"
for b in watch-stream c-cli-web rsync-web; do install -m 755 "$BIN/$b" "$OPT/bin/$b"; done
install -m 755 "$HERE/watch-torrent-done" "$OPT/bin/watch-torrent-done"

say "VueTorrent $VUETORRENT_VERSION"
if [ ! -f "$OPT/vuetorrent-$VUETORRENT_VERSION/public/index.html" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/v.zip" "https://github.com/VueTorrent/VueTorrent/releases/download/v$VUETORRENT_VERSION/vuetorrent.zip"
  echo "$VUETORRENT_SHA256  $tmp/v.zip" | sha256sum -c --quiet || { echo "VueTorrent checksum mismatch" >&2; exit 1; }
  install -d "$OPT/vuetorrent-$VUETORRENT_VERSION"
  unzip -q "$tmp/v.zip" -d "$tmp/u"
  cp -R "$tmp/u/vuetorrent/." "$OPT/vuetorrent-$VUETORRENT_VERSION/"
  chmod -R a-w "$OPT/vuetorrent-$VUETORRENT_VERSION"
  rm -rf "$tmp"
fi
ln -sfn "$OPT/vuetorrent-$VUETORRENT_VERSION" "$OPT/vuetorrent"

say "yt-dlp"
[ -x "$H/.yt-dlp/bin/python" ] || su -s /bin/sh "$U" -c "python3 -m venv $H/.yt-dlp"
su -s /bin/sh "$U" -c "$H/.yt-dlp/bin/python -m pip install -q -U pip 'yt-dlp[default]'"

say "Secrets"
gen() { [ -s "$PRIV/$1" ] || { openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-32 > "$PRIV/$1"; chmod 600 "$PRIV/$1"; }; cat "$PRIV/$1"; }
OWNER_PASS=$(gen owner-password); WORKER_PASS=$(gen worker-password); HOOK_SECRET=$(gen webhook-secret)
printf 'WATCH_HOOK_URL=%s/hooks/qbit\nWATCH_HOOK_SECRET=%s\n' "$WORKER" "$HOOK_SECRET" > "$H/.config/watch-hook.env"
chown "$U:$U" "$H/.config/watch-hook.env"; chmod 600 "$H/.config/watch-hook.env"
printf 'RSYNC_WEB_WEBHOOK_SECRET=%s\n' "$HOOK_SECRET" > "$ETC/rsync-web.env"
[ -f "$ETC/c-cli-web.env" ] || : > "$ETC/c-cli-web.env"
[ -n "$OMDB" ] && printf 'OMDB_API_KEY=%s\n' "$OMDB" > "$ETC/c-cli-web.env"
chmod 600 "$ETC/rsync-web.env" "$ETC/c-cli-web.env"

say "SSH key for $STORAGE"
[ -f "$H/.ssh/id_ed25519" ] || su -s /bin/sh "$U" -c "ssh-keygen -q -t ed25519 -N '' -C 'watchbox box $DOMAIN' -f $H/.ssh/id_ed25519"
SHOST=${STORAGE#*@}; SUSER=${STORAGE%@*}
cat > "$H/.ssh/config" <<EOF
# Written by watchbox install.sh. "storage:" in rsync destinations means the storage server.
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
su -s /bin/sh "$U" -c "ssh-keyscan -p $STORAGE_PORT -T 10 $SHOST 2>/dev/null | sort -u > $H/.ssh/known_hosts.new && [ -s $H/.ssh/known_hosts.new ] && mv $H/.ssh/known_hosts.new $H/.ssh/known_hosts || { rm -f $H/.ssh/known_hosts.new; echo 'could not read the storage server key (is it up?)' >&2; }"

say "qBittorrent"
QB=$H/.config/qBittorrent
if [ ! -f "$QB/qBittorrent.conf" ]; then   # first install only: afterwards your own settings stay
  PORT=$(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 20000 + 40000 ))
  cat > "$QB/qBittorrent.conf" <<'EOF'
[AutoRun]
enabled=true
program=@OPT@/bin/watch-torrent-done \"%I\"

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
  sed -i "s|@OPT@|$OPT|g; s|@H@|$H|g; s|@PORT@|$PORT|g" "$QB/qBittorrent.conf"
  # Watch the home folder for .torrent files (c-cli saves them there).
  printf '{\n    "%s": { "add_torrent_params": { "save_path": "" }, "recursive": false }\n}\n' "$H" > "$QB/watched_folders.json"
  chown -R "$U:$U" "$QB"
fi

say "Services"
unit() {   # name, description, ExecStart, extra [Service] lines
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
User=$U
Group=$U
Environment=HOME=$H
WorkingDirectory=$H
$4
ExecStart=$3
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
}
unit watchbox-qbittorrent "watchbox: qBittorrent (VueTorrent UI on 127.0.0.1:8080)" "/usr/bin/qbittorrent-nox" ""
unit watchbox-c-cli-web "watchbox: c-cli web, find torrents (127.0.0.1:8000)" "$OPT/bin/c-cli-web" \
  "Environment=HOST=127.0.0.1 PORT=8000 DOWNLOAD_DIR=$H
EnvironmentFile=-$ETC/c-cli-web.env"
unit watchbox-rsync-web "watchbox: rsync-web, copies to storage (127.0.0.1:8888)" \
  "$OPT/bin/rsync-web -listen 127.0.0.1:8888 -dir $H -preset Movies=storage:${SP}movies/ -preset TV=storage:${SP}tv/ -push-root media -webhook $WORKER/hooks/rsync" \
  "EnvironmentFile=$ETC/rsync-web.env"
unit watchbox-stream "watchbox: watch-stream, browser conversions and YouTube (127.0.0.1:8891)" \
  "/usr/bin/nice -n 5 $OPT/bin/watch-stream -listen 127.0.0.1:8891 -src-host $WORKER_HOST -yt-dest storage:${SP}youtube/ -yt-tv-dest storage:${SP}tv/ -yt-js-runtime node" \
  "Environment=PATH=/usr/local/bin:/usr/bin:/bin"
systemctl daemon-reload
for s in watchbox-qbittorrent watchbox-c-cli-web watchbox-rsync-web watchbox-stream; do systemctl enable -q "$s"; systemctl restart "$s"; done

say "Caddy sites cc/dl/rs.$DOMAIN"
OWNER_HASH=$(caddy hash-password --plaintext "$OWNER_PASS"); WORKER_HASH=$(caddy hash-password --plaintext "$WORKER_PASS")
install -d -m 755 /etc/caddy/sites
site() {   # host, upstream, extra handlers
  cat <<EOF

$1.$DOMAIN {
	import watchbox_box_guard
	basicauth {
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
# watchbox download box (written by install.sh). Users: "owner" (you, in a browser) and "watchworker" (the Worker).
# Cross-site browser requests are refused, so another web page can't use your browser's saved login.
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
} > /etc/caddy/sites/watchbox-box.caddy
CF=/etc/caddy/Caddyfile
[ -f "$CF" ] && cp -p "$CF" "$CF.bak-watchbox-$(date +%Y%m%d%H%M%S)"
if [ ! -f "$CF" ] || grep -q 'The Caddyfile is an easy way' "$CF"; then
  printf '# Sites are in /etc/caddy/sites/ (watchbox).\nimport /etc/caddy/sites/*.caddy\n' > "$CF"
elif ! grep -q 'import /etc/caddy/sites/\*.caddy' "$CF"; then
  printf '\nimport /etc/caddy/sites/*.caddy\n' >> "$CF"
fi
caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1 || { echo "Caddy config invalid:" >&2; caddy validate --config "$CF" --adapter caddyfile >&2; exit 1; }
systemctl enable -q caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Check"
sleep 3
for s in watchbox-qbittorrent watchbox-c-cli-web watchbox-rsync-web watchbox-stream; do printf '%-22s %s\n' "$s" "$(systemctl is-active $s)"; done
for t in cc dl rs; do
  code=000
  for i in $(seq 1 20); do code=$(curl -s -o /dev/null -w '%{http_code}' -u "owner:$OWNER_PASS" "https://$t.$DOMAIN/" || true); [ "$code" = 200 ] && break; sleep 2; done
  printf 'https://%s.%s/  %s\n' "$t" "$DOMAIN" "$([ "$code" = 200 ] && echo ok || echo "not answering yet ($code): check DNS and ports 80/443")"
done
su -s /bin/sh "$U" -c "rsync --list-only -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' storage:" >/dev/null 2>&1 &&
  echo "storage: reachable" || echo "storage: not reachable yet (add this box's key to the storage server, below)"

say "Security check"
SC="$HERE/../security-check.sh"; [ -f "$SC" ] || SC="$HERE/security-check.sh"
if [ -f "$SC" ]; then
  F=""; [ $HARDEN = 1 ] && F="--fix all-safe"; [ $FIREWALL = 1 ] && F="$F --fix firewall"
  sh "$SC" $F --torrent-port "$(sed -n 's/^Session\\Port=//p' /home/watchbox/.config/qBittorrent/qBittorrent.conf 2>/dev/null)" || true
  [ $HARDEN = 1 ] || echo "(apply the safe fixes with --harden; add --firewall to also turn on ufw)"
fi

AUTHZ="Basic $(printf 'watchworker:%s' "$WORKER_PASS" | base64 | tr -d '\n')"
cat > "$PRIV/cloudflare-values.txt" <<EOF
TOOLS={"cc":{"label":"Find","name":"c-cli","host":"<watch-cc host on your Worker domain>","upstream":"https://cc.$DOMAIN","service":"watchbox-c-cli-web"},"dl":{"label":"Downloads","name":"qBittorrent (VueTorrent)","host":"<watch-dl host>","upstream":"https://dl.$DOMAIN","service":"watchbox-qbittorrent"},"rs":{"label":"Transfer","name":"rsync-web","host":"<watch-rs host>","upstream":"https://rs.$DOMAIN","service":"watchbox-rsync-web"}}
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
