#!/bin/zsh
# gate-c1.sh: the 11-18 camera matrix c1 (camera removed 20 s, back 30 s,
# A/V windows measured) for 0.6.2 / 0.6.3 / head, Studio + Instant, 1 rep.
# Run inside hold.sh (both GUI locks).
export CAPRIG_RUNS=$HOME/gate064/caprig-runs; mkdir -p $CAPRIG_RUNS
T=~/caprig/tools
PY=~/caprig/venv/bin/python
G=$HOME/gate064
sudo launchctl asuser 501 sudo -u rmini open -n -W -a /Applications/CapRigLauncher.app --args status
for mode in studio instant; do
  for b in v062 base head; do
    $PY $T/runcase2.py --bin $G/apps/$b/bin/cap-gpui --name g064-c1-$mode-$b --mode $mode --secs 60 --cam 0 \
      --events 20:remove:0,23:shot:t23-gone,30:add:0,36:shot:t36-back,45:shot:t45 2>&1 | tail -25 > $G/out/c1-$mode-$b.txt
  done
done
touch $G/out/c1-DONE
