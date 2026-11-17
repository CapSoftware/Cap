#!/usr/bin/env bash
# The GPU device is lost while Cap's main window is hidden, so the loss is
# found by the frame that would have mapped the window again (GitHub #3946):
# close the main window, lose the device, launch Cap again, which asks the
# running instance for its window, and check the window comes back.
# GPUI_INJECT_DEVICE_LOSS names a file; creating it makes the renderer's next
# frame end as it does when the driver reports the device lost.
# Prints key=value results to $HARNESS_OUT/result.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE|HYPRLAND_INSTANCE_SIGNATURE)=" | sed 's/^/export /')"
: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
main_windows() {
  hyprctl -j clients | python3 -c 'import json, sys
print(sum(1 for client in json.load(sys.stdin) if client["title"] == "Cap" and client["mapped"]))'
}
wait_main_windows() {
  for _ in $(seq $(($2 * 4))); do
    [[ $(main_windows) == "$1" ]] && return 0
    sleep 0.25
  done
  return 1
}

# A profile past onboarding, so the window that opens is the main one.
mkdir -p "$out/profile"
cat >"$out/profile/store" <<'JSON'
{
  "general_settings": {
    "hasCompletedStartup": true,
    "hasCompletedOnboarding": true,
    "enableNotifications": false,
    "enableTelemetry": false
  }
}
JSON
trigger=$out/device-loss
pid=$(bash "$here/launch-cap.sh" cap GPUI_INJECT_DEVICE_LOSS="$trigger")
if ! wait_main_windows 1 60; then
  result first_shown no
  hyprctl -j clients >>"$out/actions.log" 2>&1
  exit 0
fi
result first_shown yes
sleep 2
hyprctl dispatch 'hl.dsp.window.close({ window = "title:^Cap$" })' >>"$out/actions.log" 2>&1
result hidden "$(wait_main_windows 0 10 && echo yes || echo no)"
sleep 1
touch "$trigger"
bash "$here/launch-cap.sh" again >/dev/null
result shown_again "$(wait_main_windows 1 20 && echo yes || echo no)"
sleep 1
result device_lost "$(grep -ac 'injected through GPUI_INJECT_DEVICE_LOSS' "$out/cap.log")"
result recovered "$(grep -ac 'GPU recovery complete' "$out/cap.log")"
result restore_failed "$(grep -ac 'Could not restore retained window visibility' "$out/cap.log")"
result cap_alive "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
result panics "$(grep -ac 'panicked at' "$out/cap.log")"
cat "$out/result.txt"
