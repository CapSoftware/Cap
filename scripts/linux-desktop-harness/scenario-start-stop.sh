#!/usr/bin/env bash
# One user-shaped run: launch Cap the way the desktop's launcher does, start a
# Display recording from the overlay, use whichever Stop control Cap offers
# (tray item or global shortcut) to start and then stop it. Prints key=value
# results to $HARNESS_OUT/result.txt.
#
# Env: HARNESS_OUT, LAUNCH (dock|terminal), RECORD_MODE (studio|instant),
#      PRESS_AFTER (seconds; with no tray item by then, press the shortcut),
#      TRAY_CLICK (host|pointer).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
launch=${LAUNCH:-dock}
mode=${RECORD_MODE:-studio}
log="$out/cap.log"

case "$launch" in
  dock) prefix=(systemd-run --user --scope --quiet --unit="app-gnome-Cap-$$.scope") ;;
  terminal) prefix=() ;;
  *) echo "unknown LAUNCH=$launch" >&2; exit 2 ;;
esac
export CAP_LAUNCH_PREFIX="${prefix[*]:-}"
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE|HYPRLAND_INSTANCE_SIGNATURE)=" | sed 's/^/export /')"

: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
count() { grep -c -- "$1" "$log" 2>/dev/null || true; }

tray_items() {
  gdbus call --session --dest org.kde.StatusNotifierWatcher --object-path /StatusNotifierWatcher \
    --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher \
    RegisteredStatusNotifierItems 2>/dev/null | grep -o "'[^']*'" | wc -l
}

point() {
  if [[ -z "$1" ]]; then
    echo "nothing to click" >>"$out/actions.log"
    return
  fi
  echo "click-at $1" >&"${POINTER[1]}"
  local line
  read -r -t 10 line <&"${POINTER[0]}"
  echo "$line" >>"$out/actions.log"
}

# Use the Stop control the way a person would.
use_control() {
  case "$1" in
    tray)
      # TRAY_CLICK=pointer clicks the icon in GNOME's top bar and then the
      # entry of the menu it opens, with the pointer. Otherwise the harness
      # activates the item itself.
      if [[ ${TRAY_CLICK:-host} == pointer ]]; then
        point "$(python3 "$here/panel-locate.py" icon)"
        local entry=""
        for _ in $(seq 20); do
          sleep 0.25
          entry=$(python3 "$here/panel-locate.py" entry recording) && break
        done
        point "$entry"
      else
        echo click >&"${TRAY_HOST[1]}"
      fi
      ;;
    shortcut) python3 "$here/mutter-keys.py" Control_L+Shift_L+F9 >>"$out/actions.log" 2>&1 ;;
    approve) python3 "$here/atspi-press.py" "${2:-Add Keyboard Shortcuts}" "${3:-^Add$}" 20 >>"$out/actions.log" 2>&1 ;;
    # No tray and no shortcut: Cap records with its controls on screen, and
    # their Stop button runs the same action this deep link does.
    visible) CAP_ARGS='cap-desktop://action?value=%22stop_recording%22' bash "$here/launch-cap.sh" cap-stop >/dev/null ;;
  esac
}

wait_log() {
  local pattern=$1 seconds=$2 since=${3:-0}
  for _ in $(seq $((seconds * 4))); do
    [[ $(count "$pattern") -gt $since ]] && return 0
    sleep 0.25
  done
  return 1
}

attempt() {
  local n=$1 started_before finished_before restored_before control=none began=$SECONDS
  started_before=$(count "recording started")
  restored_before=$(count "recording UI restored")
  finished_before=$(count "recording finished")
  # GNOME asks before granting the shortcut: a person presses Add.
  if [[ -n "${APPROVE_SHORTCUT_AFTER:-}" ]]; then
    wait_log "overlay start pressed" 30 0
    sleep "$APPROVE_SHORTCUT_AFTER"
    use_control approve
  fi
  for _ in $(seq 120); do
    sleep 0.5
    if [[ $(count "recording started") -gt $started_before ]]; then control=direct; break; fi
    if [[ $(count "recording Stop control ready") -gt 0 ]]; then
      if grep "recording Stop control ready" "$log" | tail -1 | grep -q "tray icon"; then control=tray; else control=shortcut; fi
      break
    fi
    if [[ $(count "recording with Cap's controls visible") -gt 0 ]]; then control=visible; break; fi
    if [[ $(tray_items) -gt 0 ]]; then control=tray; break; fi
    if [[ -n "${PRESS_AFTER:-}" && $((SECONDS - began)) -ge $PRESS_AFTER ]]; then control=shortcut; break; fi
  done
  result "attempt${n}_control" "$control"
  [[ $control == tray || $control == shortcut ]] && use_control "$control"
  # The screen-share dialog: a person picks the screen and presses Share.
  if [[ ${DESKTOP:-gnome} == gnome ]] && ! wait_log "recording started" 4 "$started_before"; then
    use_control approve "Share Screen|xdg-desktop-portal-gnome" "^Share$"
  fi
  if wait_log "recording started" 30 "$started_before"; then
    result "attempt${n}_started" yes
    sleep 8
    use_control "$control"
    if wait_log "recording finished" 60 "$finished_before"; then
      result "attempt${n}_finished" yes
    else
      result "attempt${n}_finished" no
    fi
    # The windows Cap hid for the capture must come back after a stop too.
    if wait_log "recording UI restored" 15 "$restored_before"; then
      result "attempt${n}_restored" yes
    else
      result "attempt${n}_restored" no
    fi
  else
    result "attempt${n}_started" no
    # A person whose recording never starts presses Stop: Cap must come back.
    if [[ $control == tray || $control == shortcut ]]; then
      [[ $(count "recording UI restored") -gt $restored_before ]] || use_control "$control"
      if wait_log "recording UI restored" 20 "$restored_before"; then
        result "attempt${n}_recovered" yes
      else
        result "attempt${n}_recovered" no
      fi
    fi
  fi
}

# One tray host connection for the whole run, like a panel (none without a
# tray: GNOME_TRAY=0).
if [[ ${GNOME_TRAY:-1} != 0 ]]; then
  coproc TRAY_HOST { python3 -u "$here/sni-click.py" "$out"; }
fi
if [[ ${TRAY_CLICK:-host} == pointer ]]; then
  # The pointer must exist before Cap starts (see mutter-pointer.py).
  coproc POINTER { python3 -u "$here/mutter-pointer.py" 2>>"$out/actions.log"; }
  read -r -t 10 ready <&"${POINTER[0]}"
  echo "$ready" >>"$out/actions.log"
fi
pid=$("$here/launch-cap.sh" cap CAP_GPUI_AUTO_RECORD="$mode:${AUTO_STOP_SECS:-900}" CAP_GPUI_AUTO_OVERLAY=display)
attempt 1

result cap_alive "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
result blocked "$(count 'A new recording is blocked')"
result restoration_unconfirmed "$(count 'restoration or Stop cleanup is unconfirmed')"
result superseded "$(count 'superseded')"
result visibility_deadline "$(count 'deadline has elapsed')"
result shortcut_changed "$(count 'recording shortcut changed')"
result app_id_required "$(count 'An app id is required')"
result tray_unavailable "$(count 'Stop tray is no longer available')"
result preflight_failed "$(count 'clean capture preflight failed')"
result pipeline_failed "$(count 'recording pipeline failed')"
crashes="$out/profile/logs/cap-gpui.log.crashes"
result panics "$(( $(count 'panicked at\|cap_desktop_panic\|panic location') + $(grep -E 'panic thread=|native crash' "$crashes" 2>/dev/null | wc -l) ))"
result projects "$(find "$out/profile/recordings" -maxdepth 1 -name '*.cap' | wc -l)"
kill "$pid" 2>/dev/null
sleep 1
cat "$out/result.txt"
