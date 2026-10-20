#!/bin/bash
# meter_probe.sh <binary> <label> [env...]: launch cap-gpui idle with a fake mic meter, settle, measure 30 s.
set -u
BIN=$1; LABEL=$2; shift 2
D=$(mktemp -d); mkdir -p "$D/data" "$D/rec"
LOG="$RUNNER_TEMP/probe-$LABEL.log"
env CAP_GPUI_APP_DATA_DIR="$D/data" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_PERF_SKIP_ONBOARDING=1 \
  CAP_PROBE_GPU=1 RUST_LOG=warn "$@" "$BIN" > "$LOG" 2>&1 &
PID=$!
sleep 20
if ! kill -0 $PID 2>/dev/null; then echo "$LABEL: app exited"; tail -20 "$LOG"; exit 0; fi
RU=$(python3 scripts/probe/ru.py $PID 30)
G=$(footprint -p $PID 2>/dev/null | grep "(graphics)" | awk '{print $1$2" "$NF" "$(NF-1)}' | tr '\n' ';')
TOT=$(footprint -p $PID 2>/dev/null | grep -m1 "Footprint:" | sed 's/.*Footprint: //')
DRAWS=$(grep "GPUPROBE draws=" "$LOG" | tail -5 | tr '\n' '|')
ATLAS=$(grep -c "GPUPROBE atlas_texture" "$LOG")
echo "$LABEL | $RU | footprint=$TOT | graphics=$G | atlas_textures=$ATLAS | last: $DRAWS" | tee -a "$RUNNER_TEMP/probe-summary.txt"
kill $PID; sleep 2; kill -9 $PID 2>/dev/null
true
