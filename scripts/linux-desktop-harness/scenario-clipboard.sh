#!/usr/bin/env bash
# Paste into and copy out of a Cap text field with the keys a person presses.
# Cap opens its teleprompter, whose script field takes focus on open; the
# compositor's virtual keyboard (wtype) presses Ctrl+V with text another app
# put on the Wayland clipboard (wl-copy), then Ctrl+A, Ctrl+C, and wl-paste
# reads back what Cap copied. The script is saved to Cap's store, so the paste
# is checked there too. Needs a wlroots-style compositor (niri, Hyprland).
# Prints key=value results to $HARNESS_OUT/result.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|HYPRLAND_INSTANCE_SIGNATURE)=" | sed 's/^/export /')"

: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
wait_log() {
  for _ in $(seq $(($2 * 4))); do
    grep -aq -- "$1" "$out/cap.log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}
# Hyprland drops the first key each new virtual keyboard sends (any client,
# not only Cap), so every wtype run leads with a Shift tap no field reacts to.
press() { wtype -k Shift_L "$@" 2>>"$out/actions.log" || echo "wtype $* failed" >>"$out/actions.log"; sleep 0.5; }
chord() { press -M ctrl "$1" -m ctrl; }

# A profile past onboarding, so the teleprompter is the window that has focus.
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
bash "$here/launch-cap.sh" cap CAP_GPUI_AUTO_TELEPROMPTER=1 >/dev/null
if ! wait_log "teleprompter window opened" 30; then
  result teleprompter_opened no
  exit 0
fi
result teleprompter_opened yes
sleep 2

probe="pasted from another app $RANDOM"
wl-copy "$probe" 2>>"$out/actions.log"
echo "clipboard holds: $(timeout 5 wl-paste -n 2>&1)" >>"$out/actions.log"
if [[ ${XDG_CURRENT_DESKTOP:-} == niri ]]; then
  NIRI_SOCKET=$(ls "$XDG_RUNTIME_DIR"/niri.*.sock 2>/dev/null | head -1) niri msg focused-window >>"$out/actions.log" 2>&1
fi
# Plain typing first, so a failed paste is told apart from keys not arriving.
press "typed by hand "
typed=no
for _ in $(seq 20); do
  grep -aqF "typed by hand" "$out/profile/store" 2>/dev/null && { typed=yes; break; }
  sleep 0.25
done
result typing_reached_field "$typed"
chord v
# The script saves on a short debounce.
saved=no
for _ in $(seq 20); do
  grep -aqF "$probe" "$out/profile/store" 2>/dev/null && { saved=yes; break; }
  sleep 0.25
done
result paste_reached_field "$saved"

wl-copy "clipboard before copy"
chord a
chord c
copied=$(timeout 5 wl-paste -n 2>/dev/null || true)
[[ $copied == *"$probe"* ]] && result copy_reached_clipboard yes || result copy_reached_clipboard no
kill -0 "$(cat "$XDG_RUNTIME_DIR/cap.pid" 2>/dev/null)" 2>/dev/null && result cap_alive yes || result cap_alive no
cat "$out/result.txt"
