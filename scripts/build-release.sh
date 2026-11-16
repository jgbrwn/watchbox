#!/bin/sh
# Builds a watchbox release bundle: dist/watchbox-<version>.tar.gz with
#   storage/  install.sh, list.php, manage.php, config.example.php, htaccess.example
#   box/      install.sh, watch-torrent-done, bin/<os>-<arch>/{watch-stream,c-cli-web,rsync-web}
#   security-check.sh (run by both installers)
# for linux and freebsd on amd64 and arm64, plus SHA256SUMS. c-cli and rsync-web are built from pinned commits.
# Usage: scripts/build-release.sh [version]     (needs go and git)
set -eu
VERSION=${1:-dev}
C_CLI_COMMIT=5e2a6aa       # github.com/jgbrwn/c-cli  (c-cli-web/)
RSYNC_WEB_COMMIT=57b6d6a   # github.com/jgbrwn/rsync-web  (./cmd/srv)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/dist/watchbox-$VERSION
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT" && mkdir -p "$OUT/storage" "$OUT/box"

git clone -q https://github.com/jgbrwn/c-cli "$WORK/c-cli" && git -C "$WORK/c-cli" checkout -q "$C_CLI_COMMIT"
git clone -q https://github.com/jgbrwn/rsync-web "$WORK/rsync-web" && git -C "$WORK/rsync-web" checkout -q "$RSYNC_WEB_COMMIT"

for os in linux freebsd; do for arch in amd64 arm64; do
  B=$OUT/box/bin/$os-$arch; mkdir -p "$B"
  export GOOS=$os GOARCH=$arch CGO_ENABLED=0
  (cd "$ROOT/box/watch-stream" && go build -trimpath -ldflags "-s -w" -o "$B/watch-stream" .)
  (cd "$WORK/c-cli/c-cli-web" && go build -trimpath -ldflags "-s -w" -o "$B/c-cli-web" .)
  (cd "$WORK/rsync-web" && go build -trimpath -ldflags "-s -w" -o "$B/rsync-web" ./cmd/srv)
  echo "built $os-$arch"
done; done
unset GOOS GOARCH CGO_ENABLED

install -m 755 "$ROOT/storage/install.sh" "$ROOT/storage/install-shared.sh" "$OUT/storage/"
install -m 644 "$ROOT/storage/list.php" "$ROOT/storage/manage.php" "$ROOT/storage/config.example.php" "$ROOT/storage/htaccess.example" "$OUT/storage/"
install -m 755 "$ROOT/box/install.sh" "$ROOT/box/install-freebsd.sh" "$ROOT/box/watch-torrent-done" "$OUT/box/"
install -m 755 "$ROOT/security-check.sh" "$OUT/"
install -m 644 "$ROOT/LICENSE" "$OUT/"
(cd "$OUT" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS)
tar -C "$ROOT/dist" -czf "$ROOT/dist/watchbox-$VERSION.tar.gz" "watchbox-$VERSION"
echo "dist/watchbox-$VERSION.tar.gz ($(du -h "$ROOT/dist/watchbox-$VERSION.tar.gz" | cut -f1))"
