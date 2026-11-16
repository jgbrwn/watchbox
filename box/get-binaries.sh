#!/bin/sh
# Puts the download box's three programs (watch-stream, c-cli-web, rsync-web) into box/bin/<os>-<arch>/.
# The installers call this; you don't need to run it yourself.
#
#   - From a release bundle they are already there: nothing to do.
#   - From a git clone, by default they are downloaded from a watchbox release on GitHub and checked against its
#     published SHA-256 (WATCHBOX_VERSION=v0.1.0 picks a release; default: the newest one).
#   - With --build they are compiled here instead: watch-stream from this checkout, c-cli and rsync-web from the
#     commits pinned in versions.env, with the official Go toolchain downloaded to a temporary folder (checksum
#     verified; nothing is installed on the system).
#
#   sh get-binaries.sh <linux|freebsd> <amd64|arm64> [--build]
set -eu
OS=$1 ARCH=$2 BUILD=${3:-}
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=$HERE/bin/$OS-$ARCH
have() { for b in watch-stream c-cli-web rsync-web; do [ -x "$BIN/$b" ] || return 1; done; }
# A release bundle has the programs and no .source file; ones this script fetched or built record where from.
if have && [ "$BUILD" != --build ] && [ ! -f "$BIN/.source" ]; then echo "programs: from the release bundle"; exit 0; fi
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else sha256 -q "$1"; fi; }
get() { curl -fsSL --retry 3 -o "$2" "$1"; }
TMP=$(mktemp -d); trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
mkdir -p "$BIN"

if [ "$BUILD" = --build ]; then
  . "$HERE/versions.env"
  echo "programs: building (Go toolchain from go.dev, c-cli $C_CLI_COMMIT, rsync-web $RSYNC_WEB_COMMIT)"
  command -v git >/dev/null || { echo "--build needs git (apt install git / pkg install git)" >&2; exit 1; }
  [ -f "$HERE/watch-stream/main.go" ] || { echo "--build needs the source: run it from a git clone of watchbox" >&2; exit 1; }
  # The toolchain runs on this machine; it builds for $OS-$ARCH (the same here, unless you cross-build).
  HOS=$(uname -s | tr A-Z a-z); case "$(uname -m)" in x86_64|amd64) HARCH=amd64 ;; aarch64|arm64) HARCH=arm64 ;; *) echo "unsupported CPU" >&2; exit 1 ;; esac
  get "https://go.dev/dl/?mode=json" "$TMP/go.json"
  # The newest stable release's archive for this system, and its checksum, from go.dev's own index.
  line=$(tr -d '\n ' < "$TMP/go.json" | grep -o "\"filename\":\"go[0-9.]*\.$HOS-$HARCH\.tar\.gz\",\"os\":\"$HOS\",\"arch\":\"$HARCH\",\"version\":\"go[0-9.]*\",\"sha256\":\"[0-9a-f]*\"" | head -1)
  file=$(echo "$line" | sed 's/.*"filename":"\([^"]*\)".*/\1/'); sum=$(echo "$line" | sed 's/.*"sha256":"\([0-9a-f]*\)".*/\1/')
  [ -n "$file" ] && [ -n "$sum" ] || { echo "couldn't find a Go release for $HOS-$HARCH on go.dev" >&2; exit 1; }
  get "https://go.dev/dl/$file" "$TMP/go.tgz"
  [ "$(sha256 "$TMP/go.tgz")" = "$sum" ] || { echo "Go download checksum mismatch" >&2; exit 1; }
  tar -xzf "$TMP/go.tgz" -C "$TMP"
  export PATH="$TMP/go/bin:$PATH" GOPATH="$TMP/gopath" GOCACHE="$TMP/gocache" GOTOOLCHAIN=local GOFLAGS=-modcacherw CGO_ENABLED=0 GOOS=$OS GOARCH=$ARCH
  git clone -q https://github.com/jgbrwn/c-cli "$TMP/c-cli" && git -C "$TMP/c-cli" checkout -q "$C_CLI_COMMIT"
  git clone -q https://github.com/jgbrwn/rsync-web "$TMP/rsync-web" && git -C "$TMP/rsync-web" checkout -q "$RSYNC_WEB_COMMIT"
  (cd "$HERE/watch-stream" && go build -trimpath -ldflags "-s -w" -o "$BIN/watch-stream" .)
  (cd "$TMP/c-cli/c-cli-web" && go build -trimpath -ldflags "-s -w" -o "$BIN/c-cli-web" .)
  (cd "$TMP/rsync-web" && go build -trimpath -ldflags "-s -w" -o "$BIN/rsync-web" ./cmd/srv)
else
  V=${WATCHBOX_VERSION:-}
  if [ -z "$V" ]; then
    get "https://api.github.com/repos/jgbrwn/watchbox/releases/latest" "$TMP/latest.json"
    V=$(grep -o '"tag_name": *"[^"]*"' "$TMP/latest.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  fi
  [ -n "$V" ] || { echo "couldn't find a watchbox release; use --build" >&2; exit 1; }
  if have && [ "$(cat "$BIN/.source" 2>/dev/null)" = "release $V" ]; then echo "programs: release $V (already here)"; exit 0; fi
  echo "programs: downloading from watchbox release $V"
  base="https://github.com/jgbrwn/watchbox/releases/download/$V/watchbox-$V.tar.gz"
  get "$base" "$TMP/r.tgz" && get "$base.sha256" "$TMP/r.sha256"
  [ "$(sha256 "$TMP/r.tgz")" = "$(cut -d' ' -f1 "$TMP/r.sha256")" ] || { echo "release checksum mismatch" >&2; exit 1; }
  tar -xzf "$TMP/r.tgz" -C "$TMP" "watchbox-$V/box/bin/$OS-$ARCH"
  cp "$TMP/watchbox-$V/box/bin/$OS-$ARCH/"* "$BIN/"
fi
chmod 755 "$BIN"/*
if [ "$BUILD" = --build ]; then echo "build $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BIN/.source"; else echo "release $V" > "$BIN/.source"; fi
have || { echo "programs missing after $([ "$BUILD" = --build ] && echo building || echo download)" >&2; exit 1; }
echo "programs: ready in $BIN"
