#!/usr/bin/env bash
set -euo pipefail

APP=$1
OUT=$2
mkdir -p "$OUT/profile/recordings" "$OUT/profile/logs"
cat > "$OUT/profile/store" <<'JSON'
{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"recording_start_safety":{"confirmBeforeRecordingWithoutMicrophone":false}}
JSON
report="$OUT/report.json"
rm -f "$report"

env CAP_GPUI_APP_DATA_DIR="$OUT/profile" \
    CAP_GPUI_RECORDINGS_DIR="$OUT/profile/recordings" \
    CAP_GPUI_LOG_DIR="$OUT/profile/logs" \
    CAP_GPUI_AUTO_NO_MIC=1 \
    CAP_PICKER_PROBE_OUTPUT="$report" \
    RUST_LOG="${RUST_LOG:-cap_gpui=info}" \
    "$APP" > "$OUT/app.log" 2>&1 &
pid=$!

for _ in $(seq 1 240); do
    [ -s "$report" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
done
kill "$pid" 2>/dev/null || true

if [ ! -s "$report" ]; then
    echo "picker probe wrote no report" >&2
    tail -n 80 "$OUT/app.log" >&2 || true
    exit 1
fi
cat "$report"
echo
grep -q '^{"passed":true,' "$report"
