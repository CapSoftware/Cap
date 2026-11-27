#!/bin/zsh
# go.sh <max hold s> <out dir> <flows> [env...]: one drive session on the mini,
# both GUI locks held, optional Retina virtual display (GATE_VDISPLAY=WxH pt).
max=$1; out=$2; flows=$3; shift 3
G=$HOME/gate064
mkdir -p $out
echo "$(date -u) start $flows" >> $G/go.log
$G/hold.sh $max /bin/zsh -c '
  G=$HOME/gate064
  vd=""
  for kv in "$@"; do case $kv in GATE_VDISPLAY=*) vd=${kv#GATE_VDISPLAY=};; esac; done
  vpid=""
  if [ -n "$vd" ]; then
    sudo launchctl asuser 501 sudo -u rmini /Users/Shared/focusfix/vdisplay ${vd%x*} ${vd#*x} '"$max"' > '"$out"'/vdisplay.log 2>&1 &
    vpid=$!
    sleep 6
    system_profiler SPDisplaysDataType | grep -E "Resolution|UI Looks" > '"$out"'/displays.txt
  fi
  sudo launchctl asuser 501 sudo -u rmini open -n -W -a /Applications/CapRigLauncher.app --args $G/run-drive.sh '"$out"' '"$flows"' "$@"
  if [ ! -s '"$out"'/drive.log ]; then
    sleep 10
    sudo launchctl asuser 501 sudo -u rmini open -n -W -a /Applications/CapRigLauncher.app --args $G/run-drive.sh '"$out"' '"$flows"' "$@"
  fi
  [ -n "$vpid" ] && { sudo pkill -f "^/Users/Shared/focusfix/vdispla[y] "; kill $vpid 2>/dev/null; }
  sudo pkill -f "^/Users/rmini/gate064/app[s]/[a-z0-9]*/bin/cap-gpui" 2>/dev/null
  true
' go "$@"
echo "$(date -u) end $flows rc $?" >> $G/go.log
