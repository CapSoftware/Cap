#!/usr/bin/env bash
# The Linux confirmation dialog for desktops without zenity
# (apps/desktop-gpui/src/linux_dialog.rs), answered with real X input on Xvfb:
# Escape and Enter on the preselected Cancel decline, Tab then Enter and a
# click on the accept button accept; an alert closes on its OK button, Enter
# and Escape. Fails unless every answer is right.
# Usage: dialog-x11.sh <cap-gpui> <ffmpeg lib dir>
set -u
command -v xdotool >/dev/null && command -v Xvfb >/dev/null || { echo "install xdotool and xvfb" >&2; exit 2; }
bin=$1; libs=$2
export LD_LIBRARY_PATH=$libs
unset WAYLAND_DISPLAY
Xvfb :77 -screen 0 1280x800x24 >/dev/null 2>&1 & xvfb=$!
export DISPLAY=:77
sleep 1
confirm='{"title":"Run diagnostic?","message":"Cap will take over your screen with a flashing pattern and play loud beeps.","accept":"Run Diagnostic","cancel":"Cancel"}'
alert='{"title":"Export failed","message":"The export could not finish.","accept":"OK","cancel":null}'
payload=$confirm title="Run diagnostic"
run() {
  local name=$1; shift
  "$bin" --cap-linux-dialog "$payload" >/tmp/dialog-$name.log 2>&1 & local p=$!
  for _ in $(seq 50); do xdotool search --name "$title" >/dev/null 2>&1 && break; sleep 0.2; done
  local win; win=$(xdotool search --name "$title" | head -1)
  sleep 1
  xdotool windowactivate --sync "$win" >/dev/null 2>&1 || xdotool windowfocus "$win"
  "$@" "$win"
  for _ in $(seq 25); do kill -0 $p 2>/dev/null || break; sleep 0.2; done
  if kill -0 $p 2>/dev/null; then echo "$name: still open"; kill $p; else wait $p; echo "$name: exit=$?"; fi
}
keys() { local win=${!#}; set -- "${@:1:$#-1}"; for k in "$@"; do xdotool key --window "$win" "$k"; sleep 0.2; done; }
click() { local win=$3; eval "$(xdotool getwindowgeometry --shell "$win")"; xdotool mousemove $((X + WIDTH * $1 / 1000)) $((Y + HEIGHT * $2 / 1000)) click 1; }
failures=0
expect() {
  local want=$1 name=$2; shift 2
  local got; got=$(run "$name" "$@")
  echo "$got"
  [[ $got == "$name: exit=$want" ]] || failures=$((failures + 1))
}
expect 1 escape keys Escape
expect 0 tab-enter keys Tab Return
expect 1 enter-default keys Return
expect 0 click-accept click 276 683
expect 1 click-cancel click 722 683
payload=$alert title="Export failed"
expect 0 alert-click-ok click 502 641
expect 0 alert-enter keys Return
expect 0 alert-escape keys Escape
kill $xvfb
exit $failures
