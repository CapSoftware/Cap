#!/usr/bin/env bash
# Records from a producer that shares frames the way niri 26.04 does, through
# Cap's PipeWire capture loop (GitHub #2941). Starts a private PipeWire and
# WirePlumber, so it runs on any Linux host with them installed.
# Usage: run.sh   (from the repository root; needs gcc, pkg-config,
#                  libpipewire-0.3-dev, pipewire, wireplumber, dbus)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
export CAP_FAKE_NIRI_PRODUCER="$work/producer"
trap 'find "$work" -mindepth 1 -delete 2>/dev/null || true' EXIT
gpu_flags=()
gpu_libraries=()
if [[ -n "${CAP_TEST_DRM_RENDER_NODE:-}" ]]; then
  gpu_flags=(-DCAP_TEST_GBM)
  gpu_libraries=(gbm)
fi
gcc -Wall -Wextra -Werror "${gpu_flags[@]}" -o "$CAP_FAKE_NIRI_PRODUCER" "$here/producer.c" \
  $(pkg-config --cflags --libs libpipewire-0.3 "${gpu_libraries[@]}")
if [[ "${CAP_TEST_USE_EXISTING_PIPEWIRE:-0}" == 1 ]]; then
  cargo test -p cap-recording --locked --lib \
    frames_from_a_producer_that_shares_only_dmabufs_are_captured -- --ignored --nocapture
  exit
fi
export XDG_RUNTIME_DIR="$work/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"
# The daemons belong to the inner shell, so it stops them before the outer
# trap removes their runtime directory.
WORK="$work" dbus-run-session -- bash -euc '
  pipewire >"$WORK/pipewire.log" 2>&1 &
  daemons=$!
  trap "kill \$daemons 2>/dev/null; wait \$daemons 2>/dev/null || true" EXIT
  for _ in $(seq 50); do [[ -S "$XDG_RUNTIME_DIR/pipewire-0" ]] && break; sleep 0.1; done
  wireplumber >"$WORK/wireplumber.log" 2>&1 &
  daemons="$daemons $!"
  sleep 2
  cargo test -p cap-recording --locked --lib \
    frames_from_a_producer_that_shares_only_dmabufs_are_captured -- --ignored --nocapture
'
