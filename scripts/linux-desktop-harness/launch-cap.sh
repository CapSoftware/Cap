#!/usr/bin/env bash
# Launches Cap in a throwaway profile with the harness hooks. Usage:
#   launch-cap.sh <name> [KEY=VALUE...]
# CAP_ARGS is passed to Cap as its one argument (a deep link).
# Logs go to $HARNESS_OUT/<name>.log; the PID to $XDG_RUNTIME_DIR/<name>.pid.
set -euo pipefail
name=$1
shift
: "${CAP_BIN:=/usr/bin/Cap}"
profile="$HARNESS_OUT/profile"
mkdir -p "$profile/recordings" "$profile/logs"
if [[ ! -f "$profile/store" ]]; then
  cat >"$profile/store" <<'JSON'
{
  "general_settings": {
    "hasCompletedOnboarding": true,
    "enableNotifications": false,
    "enableTelemetry": false,
    "recordingCountdown": 0
  },
  "recording_start_safety": {
    "confirmBeforeRecordingWithoutMicrophone": false
  }
}
JSON
fi
env \
  CAP_GPUI_APP_DATA_DIR="$profile" \
  CAP_GPUI_RECORDINGS_DIR="$profile/recordings" \
  CAP_GPUI_LOG_DIR="$profile/logs" \
  CAP_GPUI_AUTO_NO_MIC=1 \
  RUST_LOG="${RUST_LOG:-info}" \
  "$@" \
  ${CAP_LAUNCH_PREFIX:-} "$CAP_BIN" ${CAP_ARGS:+"$CAP_ARGS"} >"$HARNESS_OUT/$name.log" 2>&1 &
echo $! >"$XDG_RUNTIME_DIR/$name.pid"
echo $!
