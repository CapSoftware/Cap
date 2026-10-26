#!/usr/bin/env bash
# Launch Cap from a terminal, then launch it again from the app grid while it
# runs: the second launch must hand over to the first, whose environment
# differs (a terminal has DISPLAY and XDG_SESSION_ID; GNOME's launcher does
# not pass them). Prints key=value results to $HARNESS_OUT/result.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP)=" | sed 's/^/export /')"

: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
wait_log() {
  for _ in $(seq $(($3 * 4))); do
    grep -q -- "$2" "$out/$1.log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

DISPLAY=:0 XDG_SESSION_ID=2 bash "$here/launch-cap.sh" cap >/dev/null
if ! wait_log cap "main window opened" 30; then
  result first_ready no
  exit 0
fi
result first_ready yes
sleep 2
export CAP_LAUNCH_PREFIX="systemd-run --user --scope --quiet --unit=app-gnome-Cap-$$.scope env -u DISPLAY -u XDG_SESSION_ID"
bash "$here/launch-cap.sh" second >/dev/null
second=$(cat "$XDG_RUNTIME_DIR/second.pid")
for _ in $(seq 40); do kill -0 "$second" 2>/dev/null || break; sleep 0.25; done
pid=$(cat "$XDG_RUNTIME_DIR/cap.pid" 2>/dev/null)
if grep -q "Requested the existing Cap GPUI controls" "$out/second.log" \
  && [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
  result reopen_forwarded yes
else
  result reopen_forwarded no
  grep -h "reopen\|activation" "$out/second.log" | tail -2 >>"$out/actions.log"
fi
if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then result cap_alive yes; else result cap_alive no; fi
