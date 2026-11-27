#!/usr/bin/env bash
# scenarios.sh <bins dir> <out dir>: base and head, settings at three scroll offsets, then the meeting doc.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BINS=$1 OUT=$2
ext=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ext=".exe" ;; esac
for v in base head; do
  [ -e "$BINS/$v/cap-gpui$ext" ] || continue
  for y in ${SCROLLS:-1700 2100}; do
    bash "$HERE/run.sh" "$BINS/$v/cap-gpui$ext" "$OUT/$v" "settings-$y" settings "$y"
  done
done
