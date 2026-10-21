#!/bin/bash
# measure.sh <binary> <variant> <scenario> <round>: launch cap-gpui with a picker open, settle, measure.
set -u
BIN=$1; VARIANT=$2; SCENARIO=$3; ROUND=$4
OUT="$RUNNER_TEMP/target-ab-out"; mkdir -p "$OUT"
LABEL="$VARIANT-$SCENARIO-r$ROUND"
D=$(mktemp -d); mkdir -p "$D/data" "$D/rec"
LOG="$OUT/$LABEL.log"
case "$SCENARIO" in
  display) PANEL=display ;;
  *) PANEL=window ;;
esac
env CAP_GPUI_APP_DATA_DIR="$D/data" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_PERF_SKIP_ONBOARDING=1 \
  CAP_GPUI_AUTO_PANEL=$PANEL RUST_LOG=warn "$BIN" > "$LOG" 2>&1 &
PID=$!
sleep 20
if ! kill -0 $PID 2>/dev/null; then echo "$LABEL: app exited"; tail -30 "$LOG"; exit 0; fi
SECS=60
MOVER=
if [[ "$SCENARIO" == "move" ]]; then
  (
    i=0
    while true; do
      sleep 6
      i=$((i + 1))
      xdotool search --name "^probe-1$" windowmove $((100 + (i % 2) * 300)) 100 2>/dev/null || true
    done
  ) &
  MOVER=$!
fi
START=$(wc -l < "$LOG")
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
[ -n "$MOVER" ] && kill $MOVER 2>/dev/null
WIN=$(sed -n "$((START+1)),${END}p" "$LOG")
sum() { echo "$WIN" | grep -o "$1=[0-9]*" | awk -F= '{t+=$2} END {printf "%d", t}'; }
RENDERS=$(sum 'TPROBE renders'); DCAP=$(sum dcap); DCAPUS=$(sum dcap_us); WCAP=$(sum wcap); WCAPUS=$(sum wcap_us)
echo "variant=$VARIANT scenario=$SCENARIO round=$ROUND secs=$SECS cpu=$CPU renders=$RENDERS dcap=$DCAP dcap_us=$DCAPUS wcap=$WCAP wcap_us=$WCAPUS" | tee -a "$OUT/summary.txt"
kill $PID; sleep 2; kill -9 $PID 2>/dev/null
true
