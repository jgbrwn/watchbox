#!/bin/sh
# watchbox security check for a storage VPS or download box (Debian / Ubuntu; FreeBSD: report only).
#
#   sudo sh security-check.sh                  report only (the installers run this at the end)
#   sudo sh security-check.sh --fix ITEM ...   apply one or more fixes; ITEMS: ssh-root ssh-password updates
#                                              fail2ban timesync firewall    (or --fix all-safe = everything but
#                                              firewall)   add --dry-run to see what a fix would do
#
# Fixes never lock you out: SSH fixes need a working key login for root or a sudo user first, and the firewall
# fix always allows the SSH port it finds. The firewall is opt-in only (never part of all-safe) because providers
# and other software (Docker publishes ports around ufw, VPNs, panels) may depend on the current rules.
set -u
FIXES= DRY=0 TORRENT_PORT=
while [ $# -gt 0 ]; do
  case "$1" in
    --fix) FIXES="$FIXES $2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --torrent-port) TORRENT_PORT=$2; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
case " $FIXES " in *" all-safe "*) FIXES="$FIXES ssh-root ssh-password updates fail2ban timesync" ;; esac
want() { case " $FIXES " in *" $1 "*) return 0 ;; esac; return 1; }
OS=$(uname -s)
ok() { printf '  [ok]    %s\n' "$*"; }
warn() { printf '  [warn]  %s\n' "$*"; WARNS=$((WARNS + 1)); }
info() { printf '  [info]  %s\n' "$*"; }
did() { [ $DRY = 1 ] && printf '  [plan]  %s\n' "$*" || printf '  [fixed] %s\n' "$*"; }
run() { [ $DRY = 1 ] || sh -c "$*"; }
WARNS=0
echo "watchbox security check ($(hostname), $OS)"

# ---------- SSH ----------
if [ "$OS" = Linux ] && command -v sshd >/dev/null 2>&1; then
  T=$(sshd -T 2>/dev/null)
  SSH_PORT=$(echo "$T" | awk '/^port /{print $2; exit}'); SSH_PORT=${SSH_PORT:-22}
  # Someone can log in with a key: root, or a member of sudo with authorized_keys.
  keyed=0
  [ -s /root/.ssh/authorized_keys ] && keyed=1
  for u in $(getent group sudo | cut -d: -f4 | tr , ' '); do h=$(getent passwd "$u" | cut -d: -f6); [ -s "$h/.ssh/authorized_keys" ] && keyed=1; done
  dropin=/etc/ssh/sshd_config.d/10-watchbox.conf
  rl=$(echo "$T" | awk '/^permitrootlogin /{print $2}')
  if [ "$rl" = yes ]; then
    warn "SSH allows root to log in with a password (PermitRootLogin yes)  -> --fix ssh-root"
    if want ssh-root; then
      if [ $keyed = 1 ]; then did "PermitRootLogin prohibit-password ($dropin)"; run "echo 'PermitRootLogin prohibit-password' >> $dropin && sshd -t && systemctl reload ssh"
      else warn "  not fixed: no SSH key login found for root or a sudo user (you'd risk locking yourself out)"; fi
    fi
  else ok "SSH root login: $rl"; fi
  pa=$(echo "$T" | awk '/^passwordauthentication /{print $2}')
  if [ "$pa" = yes ]; then
    warn "SSH accepts passwords (bots try them all day)  -> --fix ssh-password"
    if want ssh-password; then
      if [ $keyed = 1 ]; then did "PasswordAuthentication no, KbdInteractiveAuthentication no ($dropin)"; run "printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >> $dropin && sshd -t && systemctl reload ssh"
      else warn "  not fixed: no SSH key login found for root or a sudo user"; fi
    fi
  else ok "SSH passwords: off"; fi
fi

# ---------- updates, fail2ban, time ----------
if [ "$OS" = Linux ]; then
  if dpkg -s unattended-upgrades >/dev/null 2>&1 && [ "$(apt-config dump 2>/dev/null | awk -F'"' '/APT::Periodic::Unattended-Upgrade /{print $2}')" = 1 ]; then
    ok "automatic security updates: on"
  else
    warn "automatic security updates: off  -> --fix updates"
    want updates && { did "install unattended-upgrades and enable it"; run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null && printf 'APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n' > /etc/apt/apt.conf.d/20auto-upgrades"; }
  fi
  if systemctl is-active -q fail2ban 2>/dev/null; then ok "fail2ban: running"
  else
    warn "fail2ban (bans IPs that keep failing SSH logins): not running  -> --fix fail2ban"
    want fail2ban && { did "install fail2ban with the sshd jail"; run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban python3-systemd >/dev/null && printf '[sshd]\nenabled = true\nbackend = systemd\n' > /etc/fail2ban/jail.d/watchbox.local && systemctl enable -q --now fail2ban && systemctl restart fail2ban"; }
  fi
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then ok "clock: synchronised (signed requests and certificates need it)"
  else
    warn "clock: not synchronised  -> --fix timesync"
    want timesync && { did "enable systemd-timesyncd"; run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-timesyncd >/dev/null; timedatectl set-ntp true"; }
  fi
  [ -f /var/run/reboot-required ] && info "a reboot is pending (kernel or library updates)"
fi

# ---------- what listens on the internet ----------
if command -v ss >/dev/null 2>&1; then
  public=$(ss -Htuln | awk '{print $1, $5}' | grep -vE ' (127\.[0-9.]+|\[::1\]|::1):' | grep -vE ' (127\.0\.0\.53|127\.0\.0\.54)' | awk '{n=split($2,a,":"); print $1"/"a[n]}' | sort -u | tr '\n' ' ')
  info "listening on public addresses: ${public:-none}"
  for p in 8000 8080 8888 8891; do
    ss -Htln "sport = :$p" | awk '{print $4}' | grep -vqE '^(127\.|\[::1\])' && ss -Htln "sport = :$p" | grep -q . && warn "port $p (a watchbox app) is reachable from outside; it should listen on 127.0.0.1 only"
  done
fi

# ---------- firewall ----------
if [ "$OS" = Linux ]; then
  fw=none
  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active' && fw=ufw
  [ $fw = none ] && command -v nft >/dev/null 2>&1 && nft list ruleset 2>/dev/null | grep -qE 'hook input .*policy drop' && fw=nftables
  [ $fw = none ] && iptables -S INPUT 2>/dev/null | grep -q '^-P INPUT DROP' && fw=iptables
  docker=0; command -v docker >/dev/null 2>&1 && docker ps -q 2>/dev/null | grep -q . && docker=1
  if [ $fw != none ]; then ok "firewall: $fw is filtering incoming traffic"
  else
    warn "firewall: incoming traffic isn't filtered (everything that listens publicly is reachable)  -> --fix firewall (opt-in)"
    if want firewall; then
      ports="${SSH_PORT:-22}/tcp 80/tcp 443/tcp 443/udp"
      [ -n "$TORRENT_PORT" ] && ports="$ports $TORRENT_PORT/tcp $TORRENT_PORT/udp"
      did "ufw: deny incoming except $ports"
      [ $docker = 1 ] && info "Docker is running: ports it publishes bypass ufw and keep working (e.g. VPN containers)"
      run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null && ufw default deny incoming >/dev/null && ufw default allow outgoing >/dev/null && for p in $ports; do ufw allow \$p >/dev/null; done && ufw --force enable >/dev/null"
    fi
  fi
fi

# ---------- watchbox files ----------
for d in /var/lib/watchbox-storage /var/lib/watchbox-box /etc/watchbox; do
  [ -d "$d" ] || continue
  m=$(stat -c %a "$d" 2>/dev/null || stat -f %Lp "$d")
  case "$d:$m" in /etc/watchbox:7[05][05]) ;; *:700) ;; *) warn "$d is mode $m (should be 700)";; esac
  loose=$(find "$d" -type f -perm /077 ! -name '*.txt' 2>/dev/null | grep -v '^/etc/watchbox/.*\.env$' | head -3)
  [ -n "$loose" ] && warn "readable by others: $loose"
done
for e in /etc/watchbox/*.env; do [ -f "$e" ] && [ "$(stat -c %a "$e")" != 600 ] && warn "$e should be mode 600"; done
QB=/home/watchbox/.config/qBittorrent/qBittorrent.conf
if [ -f "$QB" ]; then
  grep -q '^WebUI\\Address=127.0.0.1' "$QB" && ok "qBittorrent web UI: 127.0.0.1 only (Caddy's login in front)" || warn "qBittorrent web UI isn't limited to 127.0.0.1, but its own login is off: set WebUI\\Address=127.0.0.1"
fi

echo
[ $WARNS = 0 ] && echo "No warnings." || echo "$WARNS warning(s). Fixes are optional; see --help."
exit 0
