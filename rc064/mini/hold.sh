#!/bin/zsh
# hold.sh <max hold s> <cmd...>: run cmd holding both mini GUI locks
# (/Users/Shared/cap-gui.lock via mkdir + /Volumes/CapGPUIBuild/locks/gui via
# guilock.sh queue). Releases both on exit; kills cmd's tree past max hold.
max=$1; shift
S=/Users/Shared/cap-gui.lock
waited=0
until mkdir $S 2>/dev/null; do
  age=$(( $(date +%s) - $(stat -f %m $S 2>/dev/null || date +%s) ))
  [ $waited -eq 0 ] && echo "waiting for $S held by $(cat $S/owner 2>/dev/null) age $age"
  waited=$((waited+5)); sleep 5
  [ $waited -gt 3600 ] && { echo "cap-gui.lock not free after 1h"; exit 3; }
done
echo gate064 > $S/owner; chmod -R 777 $S
trap 'rm -f $S/owner; rmdir $S 2>/dev/null' EXIT INT TERM
~/caprig/guilock.sh 3600 /bin/zsh -c '
  echo gate064 > /Volumes/CapGPUIBuild/locks/gui.owner
  "$@" &
  pid=$!
  ( sleep '"$max"'; echo "WATCHDOG: hold over '"$max"' s, killing"; pkill -TERM -P $pid; kill -TERM $pid ) &
  dog=$!
  wait $pid; rc=$?
  kill $dog 2>/dev/null
  exit $rc
' hold "$@"
