#!/bin/bash
# measure.sh <binary> <variant> <profile> <round>: launch cap-gpui idle, settle, measure 30 s.
set -u
BIN=$1; VARIANT=$2; PROFILE=$3; ROUND=$4
OUT="$RUNNER_TEMP/meter-ab-out"; mkdir -p "$OUT"
LABEL="$VARIANT-$PROFILE-r$ROUND"
D=$(mktemp -d); mkdir -p "$D/data" "$D/rec"
LOG="$OUT/$LABEL.log"
envs=(CAP_GPUI_APP_DATA_DIR="$D/data" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_PERF_SKIP_ONBOARDING=1 CAP_PROBE_GPU=1 RUST_LOG=warn)
[ "$PROFILE" != none ] && envs+=(CAP_PROBE_FAKE_MIC="$PROFILE")
env "${envs[@]}" "$BIN" > "$LOG" 2>&1 &
PID=$!
sleep 18
if ! kill -0 $PID 2>/dev/null; then echo "$LABEL: app exited"; tail -30 "$LOG"; exit 0; fi
START=$(wc -l < "$LOG")
SECS=30
if [[ "$(uname)" == "Darwin" ]]; then
  CPU=$(python3 "$(dirname "$0")/ru.py" $PID $SECS | sed -E 's/^cpu%=([0-9.]+).*/\1/')
else
  TCK=$(getconf CLK_TCK)
  a=$(awk '{print $14+$15}' /proc/$PID/stat); t0=$(date +%s.%N)
  sleep $SECS
  b=$(awk '{print $14+$15}' /proc/$PID/stat); t1=$(date +%s.%N)
  CPU=$(python3 -c "print(f'{100*($b-$a)/$TCK/($t1-$t0):.2f}')")
fi
END=$(wc -l < "$LOG")
WIN=$(sed -n "$((START+1)),${END}p" "$LOG")
RENDERS=$(echo "$WIN" | grep -o 'METERPROBE main_renders=[0-9]*' | awk -F= -v s=$SECS '{t+=$2} END {printf "%.1f", t/s}')
MIC=$(echo "$WIN" | grep -o 'mic=[a-z]*' | tail -1)
PUSHES=$(echo "$WIN" | grep -o 'pushes=[0-9]*' | awk -F= -v s=$SECS '{t+=$2} END {printf "%.0f", t/s}')
GPU=$(echo "$WIN" | grep -o 'GPUPROBE draws=[0-9]*' | awk -F= -v s=$SECS '{t+=$2} END {printf "%.1f", t/s}')
echo "variant=$VARIANT profile=$PROFILE round=$ROUND cpu=$CPU main_renders_per_s=$RENDERS gpu_draws_per_s=$GPU $MIC pushes_per_s=$PUSHES" | tee -a "$OUT/summary.txt"
kill $PID; sleep 2; kill -9 $PID 2>/dev/null
true
