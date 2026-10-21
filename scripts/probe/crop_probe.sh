#!/bin/bash
# crop_probe.sh <binary> <label> <cycles> [env...]
set -u
BIN=$1; LABEL=$2; CYCLES=$3; shift 3
D=$(mktemp -d); mkdir -p "$D/data" "$D/rec"
LOG="$RUNNER_TEMP/probe-$LABEL.log"
FIX="$RUNNER_TEMP/fixture/Probe.cap"
env CAP_GPUI_APP_DATA_DIR="$D/data" CAP_GPUI_RECORDINGS_DIR="$D/rec" COMET_GPU_STATS=1 RUST_LOG=warn \
  CAP_GPUI_AUTO_SCREENSHOT_EDITOR="$FIX" CAP_PROBE_CROP_CYCLES="$CYCLES" "$@" "$BIN" > "$LOG" 2>&1 &
PID=$!
fp() { footprint -p $PID 2>/dev/null | grep -m1 "Footprint:" | sed 's/.*Footprint: //'; }
gfx() { footprint -p $PID 2>/dev/null | grep -i "IOAccelerator\|IOSurface\|graphics" | head -4 | awk '{print $1$2" "$NF}' | tr '\n' ';'; }
for i in $(seq 1 60); do grep -q "PROBE start" "$LOG" && break; sleep 1; done
START_FP=$(fp); START_G=$(gfx)
START_STATS=$(grep "\[gpu-stats\]" "$LOG" | tail -1)
for i in $(seq 1 $((CYCLES * 6 + 120))); do grep -q "PROBE complete" "$LOG" && break; kill -0 $PID 2>/dev/null || break; sleep 1; done
END_FP=$(fp); END_G=$(gfx)
END_STATS=$(grep "\[gpu-stats\]" "$LOG" | tail -1)
RELEASES=$(grep "PROBE release" "$LOG" | sort | uniq -c | tr '\n' ' ')
{
  echo "### $LABEL ($CYCLES cycles)"
  echo "- footprint start=$START_FP end=$END_FP"
  echo "- graphics start=$START_G end=$END_G"
  echo "- gpu-stats start: $START_STATS"
  echo "- gpu-stats end: $END_STATS"
  echo "- releases: $RELEASES"
  echo
} | tee -a "$RUNNER_TEMP/probe-summary.txt"
grep "\[gpu-stats\]" "$LOG" | tail -20
kill $PID; sleep 2; kill -9 $PID 2>/dev/null
true
