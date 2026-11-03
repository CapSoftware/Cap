#!/usr/bin/env bash
# Open Cap's settings and close it from the window itself, as a person does:
# on GNOME the compositor draws no title bar, so the window must carry its own
# close button. Prints key=value results to $HARNESS_OUT/result.txt.
# Needs GNOME_UNSAFE=1 (window lookup for the click).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
log="$out/cap.log"
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP)=" | sed 's/^/export /')"

: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
# Prints yes or no; prints nothing when GNOME could not be asked.
settings_shown() {
  local reply
  reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
    "global.display.list_all_windows().some(w => w.get_title() === 'Cap Settings')" 2>/dev/null)
  case "$reply" in
    "(true, 'true')") echo yes ;;
    "(true, 'false')") echo no ;;
  esac
}
wait_log() {
  for _ in $(seq $(($2 * 4))); do
    grep -q -- "$1" "$log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# The pointer exists before Cap starts, as a real mouse does.
coproc POINTER { python3 -u "$here/mutter-pointer.py" 2>>"$out/actions.log"; }
read -r -t 10 ready <&"${POINTER[0]}"; echo "$ready" >>"$out/actions.log"
click() { echo "click $*" >&"${POINTER[1]}"; read -r -t 10 line <&"${POINTER[0]}"; echo "$line" >>"$out/actions.log"; }

export CAP_LAUNCH_PREFIX="systemd-run --user --scope --quiet --unit=app-gnome-Cap-$$.scope"
CAP_ARGS='cap-desktop://action?value=%7B%22open_settings%22%3A%7B%22page%22%3Anull%7D%7D' \
  bash "$here/launch-cap.sh" cap >/dev/null
if ! wait_log "settings window opened" 30; then
  result settings_opened no
  exit 0
fi
result settings_opened yes
# GNOME starts in the Activities overview; leave it as a person would.
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
  --method org.gnome.Shell.Eval 'Main.overview.hide()' >/dev/null 2>&1
sleep 3
before=$(settings_shown)
result settings_shown "${before:-unknown}"
bash "$here/shot.sh" "$out/settings.png" >>"$out/actions.log" 2>&1 || true
if [[ -n "${PROBE_CLICK:-}" ]]; then
  click "^Cap.Settings$" $PROBE_CLICK
  sleep 1
  bash "$here/shot.sh" "$out/probe.png" >>"$out/actions.log" 2>&1 || true
fi
# The close button sits 24 px in from the top-right corner of the frame.
click "^Cap.Settings$" 1 0 -24 24
sleep 2
bash "$here/shot.sh" "$out/after-click.png" >>"$out/actions.log" 2>&1 || true
after=$(settings_shown)
pid=$(cat "$XDG_RUNTIME_DIR/cap.pid" 2>/dev/null)
alive=no
[[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=yes
result cap_alive "$alive"
# Closed means: seen before the click, seen gone after it, and Cap still up.
if [[ $before == yes && $after == no && $alive == yes ]]; then
  result settings_closed yes
else
  result settings_closed no
fi
