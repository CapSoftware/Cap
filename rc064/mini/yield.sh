#!/bin/zsh
# yield.sh <owner> <max s>: pause my WAITING hold.sh processes (the ones still in
# the cap-gui.lock mkdir loop, i.e. not running a session) until <owner> holds
# /Users/Shared/cap-gui.lock, or <max s> pass; then resume them.
owner=$1; max=$2
L=$HOME/gate064/go.log
stopped=()
for p in $(pgrep -f "^/bin/zsh /Users/rmini/gate064/hold\.sh"); do
  if ! pgrep -P $p >/dev/null || [ "$(pgrep -P $p | xargs ps -o comm= -p 2>/dev/null | grep -c sleep)" -gt 0 ]; then
    if ! pgrep -P $p -f guilock >/dev/null; then
      kill -STOP $p && stopped+=$p
    fi
  fi
done
echo "$(date -u) yield: paused ${stopped[*]} for $owner" >> $L
t=0
until [ "$(cat /Users/Shared/cap-gui.lock/owner 2>/dev/null)" = "$owner" ] || [ $t -ge $max ]; do
  sleep 2; t=$((t+2))
done
echo "$(date -u) yield: owner now $(cat /Users/Shared/cap-gui.lock/owner 2>/dev/null) after ${t}s; resuming" >> $L
for p in $stopped; do kill -CONT $p 2>/dev/null; done
