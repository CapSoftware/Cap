#!/usr/bin/env bash
# Records from a producer that shares frames the way niri 26.04 does, through
# Cap's PipeWire capture loop (GitHub #2941). Starts a private PipeWire and
# WirePlumber, so it runs on any Linux host with them installed.
# Usage: run.sh   (from the repository root; needs gcc, pkg-config,
#                  libpipewire-0.3-dev, pipewire, wireplumber)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
export XDG_RUNTIME_DIR="$work/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"
cleanup() {
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  find "$work" -mindepth 1 -delete 2>/dev/null || true
}
trap cleanup EXIT
gcc -o "$work/producer" "$here/producer.c" $(pkg-config --cflags --libs libpipewire-0.3)
dbus-run-session -- bash -c '
  pipewire >"'"$work"'/pipewire.log" 2>&1 &
  for _ in $(seq 50); do [[ -S "$XDG_RUNTIME_DIR/pipewire-0" ]] && break; sleep 0.1; done
  wireplumber >"'"$work"'/wireplumber.log" 2>&1 &
  sleep 2
  CAP_FAKE_NIRI_PRODUCER="'"$work"'/producer" cargo test -p cap-recording --lib \
    frames_from_a_producer_that_shares_only_dmabufs_are_captured -- --ignored --nocapture
'
