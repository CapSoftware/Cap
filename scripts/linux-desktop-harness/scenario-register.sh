#!/usr/bin/env bash
# Cap launched from a shell, which gives the portals no app id, names itself
# so.cap.Cap through the host portal registry. Other apps' entries are written
# and looked up first, as on a desktop in use: the portal then can miss a
# just-written entry ("App info not found"). Launches Cap ROUNDS times
# (default 4), first with its desktop entry removed (Cap writes it) and then
# with the entry in place, and counts the launches that registered. Prints
# key=value results to $HARNESS_OUT/result.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
export HARNESS_OUT=${HARNESS_OUT:-/out}
out=$HARNESS_OUT
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE)=" | sed 's/^/export /')"
entry=$HOME/.local/share/applications/so.cap.Cap.desktop
rounds=${ROUNDS:-4}
: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }

launch() {
  local name=$1 log=$out/$1.log line=""
  bash "$here/launch-cap.sh" "$name" >/dev/null
  for _ in $(seq 60); do
    line=$(sed 's/\x1b\[[0-9;]*m//g' "$log" 2>/dev/null |
      grep -aoE "registered Cap's app id.*|did not take Cap's app id.*|registry did not answer|portals know Cap.*|could not write the portal app id.*" | head -1)
    [[ -n $line ]] && break
    sleep 0.25
  done
  echo "$name: ${line:-no registration line}" >>"$out/actions.log"
  kill "$(cat "$XDG_RUNTIME_DIR/$name.pid")" 2>/dev/null
  for _ in $(seq 20); do
    kill -0 "$(cat "$XDG_RUNTIME_DIR/$name.pid")" 2>/dev/null || break
    sleep 0.25
  done
  [[ $line == "registered Cap's app id"* ]] && echo yes || echo no
}

register() {
  gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop \
    --method org.freedesktop.host.portal.Registry.Register "$1" '{}' >/dev/null 2>&1
}
mkdir -p "$(dirname "$entry")"
register so.cap.Missing
for n in 1 2 3; do
  printf '[Desktop Entry]\nType=Application\nName=Other %s\nExec=env true\nNoDisplay=true\n' "$n" \
    >"$(dirname "$entry")/so.cap.Other$n.desktop"
  register "so.cap.Other$n"
  sleep 1
done

fresh=0 again=0
for n in $(seq "$rounds"); do
  rm -f "$entry"
  [[ $(launch "fresh$n") == yes ]] && fresh=$((fresh + 1))
  [[ $(launch "again$n") == yes ]] && again=$((again + 1))
done
result rounds "$rounds"
result fresh_registered "$fresh"
result again_registered "$again"
result entry_written "$([[ -f $entry ]] && echo yes || echo no)"
result panics "$(cat "$out"/fresh*.log "$out"/again*.log 2>/dev/null | grep -ac 'panicked at')"
cat "$out/result.txt"
