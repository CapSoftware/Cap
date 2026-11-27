#!/bin/zsh
# release-after.sh <done file>: when the orphaned e2e session finishes, release
# the two GUI locks it still owns (only if the owner is still gate064).
done_file=$1
for i in $(seq 1 1440); do
  [ -e $done_file ] && break
  sleep 5
done
sleep 3
sudo pkill -f "^/Users/rmini/gate064/app[s]/[a-z0-9]*/bin/cap-gpui"
if [ "$(cat /Volumes/CapGPUIBuild/locks/gui.owner 2>/dev/null)" = gate064 ]; then
  rm -f /Volumes/CapGPUIBuild/locks/gui.owner; rmdir /Volumes/CapGPUIBuild/locks/gui 2>/dev/null
fi
if [ "$(cat /Users/Shared/cap-gui.lock/owner 2>/dev/null)" = gate064 ]; then
  rm -f /Users/Shared/cap-gui.lock/owner; rmdir /Users/Shared/cap-gui.lock 2>/dev/null
fi
echo "$(date -u) released after $done_file" >> $HOME/gate064/go.log
