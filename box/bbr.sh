#!/bin/sh
# TCP congestion control on the download box (Linux or FreeBSD): reports it, or with --enable switches to BBR now and
# at every boot.
#
#   sh bbr.sh             report only
#   sudo sh bbr.sh --enable
#
# Why: copies from the box to the storage server are one TCP connection each. When the storage server is far away
# (high latency) and the route drops some packets under load, the default (Linux: cubic; FreeBSD: its default stack)
# slows down sharply at every loss and recovers slowly; BBR doesn't. One install measured ~1 MB/s with the default and
# ~4 MB/s with BBR on a 167 ms route. On a nearby storage server it makes little difference either way.
# The installers run this at the end (report only; --bbr to enable). It only affects new connections.
set -eu
ENABLE=0
case "${1:-}" in --enable) ENABLE=1 ;; '') ;; *) echo "usage: sh bbr.sh [--enable]" >&2; exit 2 ;; esac
hint="If copies to your storage are slow (a far-away storage server), BBR is often several times faster: re-run the installer with --bbr, or: sudo sh $0 --enable"

case "$(uname -s)" in
Linux)
  cur=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo unknown)
  qdisc=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo fq_codel)
  if [ "$cur" = bbr ]; then echo "TCP congestion control: bbr"; exit 0; fi
  if [ $ENABLE = 0 ]; then echo "TCP congestion control: $cur. $hint"; exit 0; fi
  modprobe tcp_bbr 2>/dev/null || true
  if ! sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null | grep -qw bbr; then
    echo "TCP congestion control: $cur (this kernel has no BBR module, so it was left as it is)"; exit 0
  fi
  echo tcp_bbr > /etc/modules-load.d/watchbox-bbr.conf
  printf '# watchbox (box/bbr.sh): BBR for copies to the storage server\nnet.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n' > /etc/sysctl.d/60-watchbox-bbr.conf
  sysctl -q -p /etc/sysctl.d/60-watchbox-bbr.conf
  echo "TCP congestion control: bbr (was $cur). Undo: rm /etc/sysctl.d/60-watchbox-bbr.conf /etc/modules-load.d/watchbox-bbr.conf; sysctl -w net.ipv4.tcp_congestion_control=$cur net.core.default_qdisc=$qdisc"
  ;;
FreeBSD)
  cur=$(sysctl -n net.inet.tcp.functions_default 2>/dev/null || echo unknown)
  if [ "$cur" = bbr ]; then echo "TCP congestion control: bbr"; exit 0; fi
  if [ $ENABLE = 0 ]; then echo "TCP congestion control: the $cur stack. $hint"; exit 0; fi
  if ! kldstat -q -n tcp_bbr && ! kldload tcp_bbr 2>/dev/null; then
    echo "TCP congestion control: the $cur stack (couldn't load tcp_bbr: it needs a kernel with TCPHPTS, as FreeBSD 14's GENERIC has; left as it is)"; exit 0
  fi
  sysrc -f /boot/loader.conf tcp_bbr_load=YES >/dev/null
  if grep -q '^net.inet.tcp.functions_default=' /etc/sysctl.conf 2>/dev/null; then
    sed -i '' 's/^net\.inet\.tcp\.functions_default=.*/net.inet.tcp.functions_default=bbr/' /etc/sysctl.conf
  else
    echo 'net.inet.tcp.functions_default=bbr' >> /etc/sysctl.conf
  fi
  sysctl net.inet.tcp.functions_default=bbr >/dev/null
  echo "TCP congestion control: bbr (was the $cur stack). Undo: sysctl net.inet.tcp.functions_default=$cur, and remove tcp_bbr_load from /boot/loader.conf and the line from /etc/sysctl.conf"
  ;;
*) echo "TCP congestion control: not checked on $(uname -s)" ;;
esac
