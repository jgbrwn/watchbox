#!/bin/sh
# Fails if anything identifying the owner's private deployment would go into the public watchbox repo.
# Usage: scripts/check-public.sh [dir]   (default: the current directory). Run in watchbox CI and before every sync.
# The patterns live in a file so the public repo can carry them without spelling them out in code review noise:
#   WATCHBOX_PRIVATE_PATTERNS=/path/to/patterns.txt  (one extended regex per line; the private repo keeps the real list)
set -eu
dir=${1:-.}
patterns=${WATCHBOX_PRIVATE_PATTERNS:-$(dirname "$0")/private-patterns.txt}
[ -f "$patterns" ] || { echo "no pattern file: $patterns" >&2; exit 2; }
hits=$(grep -rInE -f "$patterns" "$dir" --exclude-dir=.git --exclude-dir=node_modules --exclude="$(basename "$patterns")" || true)
if [ -n "$hits" ]; then
  echo "Private details found (not allowed in the public repo):"
  echo "$hits" | cut -c1-200
  exit 1
fi
echo "public check ok: $dir"
