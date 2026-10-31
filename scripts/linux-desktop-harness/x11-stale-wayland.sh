#!/usr/bin/env bash
# Usage: x11-stale-wayland.sh <cap-gpui> <ffmpeg lib dir> <out-dir>
set -uo pipefail
command -v Xvfb >/dev/null || { echo "install xvfb" >&2; exit 2; }
if [[ -z ${X11_STALE_BUS:-} ]]; then
  exec env X11_STALE_BUS=1 dbus-run-session -- bash "$0" "$@"
fi
bin=$1 libs=$2 out=$3
mkdir -p "$out" && : >"$out/result.txt" || { echo "x11-stale-wayland: cannot write to $out" >&2; exit 2; }
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
export DISPLAY=:72 XDG_SESSION_TYPE=wayland
Xvfb "$DISPLAY" -screen 0 1280x800x24 >/dev/null 2>&1 &
xvfb=$!
trap 'kill $xvfb 2>/dev/null' EXIT
sleep 1

# A runtime dir whose Wayland socket outlived its compositor, as a systemd
# user environment keeps WAYLAND_DISPLAY after a Wayland session ends.
runtime=$(mktemp -d)
python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$runtime/wayland-0"
profile=$out/profile
log=$out/cap.log
mkdir -p "$profile/logs"
printf '%s' '{"general_settings":{"hasCompletedStartup":true,"hasCompletedOnboarding":true,"enableNotifications":false,"enableTelemetry":false}}' >"$profile/store"
env LD_LIBRARY_PATH="$libs" XDG_RUNTIME_DIR="$runtime" WAYLAND_DISPLAY=wayland-0 CAP_GPUI_APP_DATA_DIR="$profile" \
  CAP_GPUI_LOG_DIR="$profile/logs" CAP_GPUI_NO_TRAY=1 RUST_LOG=info "$bin" >"$log" 2>&1 &
pid=$!
for _ in $(seq 120); do
  grep -aq "main window opened\|panic" "$log" 2>/dev/null && break
  sleep 0.25
done
sleep 2
plain=$(sed 's/\x1b\[[0-9;]*m//g' "$log")
result fell_back_to_x11 "$(grep -q "names no running compositor" <<<"$plain" && echo yes || echo no)"
result main_window "$(grep -q "main window opened" <<<"$plain" && echo yes || echo no)"
result cap_alive "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
result panics "$(grep -c "panic" <<<"$plain")"
kill "$pid" 2>/dev/null
cat "$out/result.txt"
grep -qx "fell_back_to_x11=yes" "$out/result.txt" && grep -qx "main_window=yes" "$out/result.txt" &&
  grep -qx "cap_alive=yes" "$out/result.txt" && grep -qx "panics=0" "$out/result.txt"
