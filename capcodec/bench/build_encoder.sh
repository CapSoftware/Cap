#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
TOV="${TOV:-tov}"
CPU="${CAPCODEC_TARGET_CPU:-x86-64-v3}"
if [ "$(uname -s)" = Linux ] && [[ " $* " != *" -g "* ]]; then
  FLAGS="-fno-asynchronous-unwind-tables -fno-unwind-tables -Wl,-s"
  if command -v ld.lld >/dev/null; then
    FLAGS="$FLAGS -fuse-ld=lld"
  fi
  export TOV_CFLAGS="$FLAGS ${TOV_CFLAGS:-}"
fi
"$TOV" build cli/main.tov -o build/capcodec --target-cpu "$CPU" "$@"
"$TOV" build cli/main.tov -o build/capcodec-unchecked --unchecked --target-cpu "$CPU" "$@"
"$TOV" build cli/main.tov -o build/capcodec-unchecked-baseline --unchecked "$@"
if [ "$(uname -m)" = x86_64 ]; then
  "$TOV" build cli/main.tov -o build/capcodec-unchecked-v4 --unchecked --target-cpu x86-64-v4 "$@"
fi
