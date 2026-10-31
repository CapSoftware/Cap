#!/usr/bin/env bash
# Runs cap-gpui's glass probe (src/glass_probe.rs) in a throwaway profile:
# every scene in cap_glass::scenes with glass panes in each preset, captured
# from the real window and scored against the CPU model. Fails unless every
# case passes.
#
#   scripts/glass-probe/run.sh <cap-gpui binary> <out dir>
set -euo pipefail

APP=$1
OUT=$2
mkdir -p "$OUT/profile/recordings" "$OUT/profile/logs" "$OUT/captures"
cat > "$OUT/profile/store" <<'JSON'
{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"recording_start_safety":{"confirmBeforeRecordingWithoutMicrophone":false}}
JSON
report="$OUT/captures/report.json"
rm -f "$report"

env CAP_GPUI_APP_DATA_DIR="$OUT/profile" \
    CAP_GPUI_RECORDINGS_DIR="$OUT/profile/recordings" \
    CAP_GPUI_LOG_DIR="$OUT/profile/logs" \
    CAP_GPUI_AUTO_NO_MIC=1 \
    CAP_GLASS_PROBE_OUTPUT="$OUT/captures" \
    RUST_LOG="${RUST_LOG:-cap_gpui=info}" \
    "$APP" > "$OUT/app.log" 2>&1 &
pid=$!

for _ in $(seq 1 1200); do
    [ -s "$report" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
done
kill "$pid" 2>/dev/null || true

if [ ! -s "$report" ]; then
    echo "glass probe wrote no report" >&2
    tail -n 80 "$OUT/app.log" >&2 || true
    exit 1
fi
# Windows images ship `python`, not `python3`.
PYTHON=$(command -v python3 || command -v python)
"$PYTHON" - "$report" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
print(f"scale {report.get('scale')}  passed {report['passed']}")
for case in report.get("cases", []):
    if "error" in case:
        print(f"  {case['name']:28s} error: {case['error']}")
    else:
        mark = "ok " if case["passed"] else "BAD"
        print(f"  {mark} {case['name']:28s} ssim {case['ssim']:.4f}  dE {case['deltaE']:.2f}  dE95 {case['deltaE95']:.2f}")
sys.exit(0 if report["passed"] else 1)
PY
