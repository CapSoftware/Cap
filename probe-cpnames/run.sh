#!/usr/bin/env bash
# run.sh <cap-gpui> <out dir> <shot name> <settings|doc> [scroll y]
# A throwaway profile of an existing Notes user who had "Name speakers from meeting apps" on, then either the
# Notes settings page (scrolled) or a finished Zoom meeting whose voices are still "Person n".
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$1 OUT=$2 NAME=$3 MODE=$4 SCROLL=${5:-0}
WAIT=${PROBE_WAIT:-25}
OS=$(uname -s)
case "$OS" in MINGW*|MSYS*|CYGWIN*) OS=Windows ;; esac

prof="$OUT/profiles/$NAME"
mkdir -p "$prof/meetings" "$prof/logs" "$prof/documents/cpnames1" "$OUT/shots" "$OUT/logs"
cat > "$prof/store" <<'JSON'
{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0,"theme":"light"}}
JSON
cat > "$prof/meetings/settings.json" <<'JSON'
{"enabled": true, "setupCompleted": true, "transcription": {"engine": "local", "live": true, "nameSpeakersFromApps": true}}
JSON
cp "$HERE/doc.json" "$HERE/transcript.jsonl" "$prof/documents/cpnames1/"

native() { if [ "$OS" = Windows ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
shot() {
  local file="$OUT/shots/$1.png"
  case "$OS" in
    Darwin) screencapture -x "$file" ;;
    Linux) import -window root "$file" ;;
    Windows) powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$HERE/shot.ps1")" "$(cygpath -w "$file")" ;;
  esac
}

export CAP_GPUI_APP_DATA_DIR="$(native "$prof")"
export CAP_GPUI_TAURI_STORE="$(native "$prof/store")"
export CAP_GPUI_LOG_DIR="$(native "$prof/logs")"
export CAP_GPUI_NO_TRAY=1 CAP_GPUI_AUTO_NO_MIC=1
export RUST_LOG="${RUST_LOG:-cap_gpui=info,cap_meetings=info}"
if [ "$MODE" = settings ]; then
  export CAP_GPUI_AUTO_SETTINGS=meetings CAP_GPUI_SETTINGS_SCROLL_Y="$SCROLL"
else
  export CAP_GPUI_DOCS_OPEN=1 CAP_GPUI_DOCS_DOC=cpnames1 CAP_GPUI_DOCS_STATE=view:transcript
fi
log="$OUT/logs/$NAME.log"
if [ "$OS" = Windows ]; then
  powershell -NoProfile -Command "Start-Process -FilePath '$(cygpath -w "$APP")' -WorkingDirectory '$(cygpath -w "$(dirname "$APP")")' -RedirectStandardOutput '$(cygpath -w "$log")' -RedirectStandardError '$(cygpath -w "$log.err")'"
else
  "$APP" > "$log" 2>&1 &
  pid=$!
fi
sleep "$WAIT"
shot "$NAME"
if [ "$OS" = Windows ]; then
  taskkill //F //IM cap-gpui.exe > /dev/null 2>&1
else
  kill "$pid" 2>/dev/null; sleep 2; kill -9 "$pid" 2>/dev/null
fi
sleep 2
cp "$prof/meetings/settings.json" "$OUT/logs/$NAME.settings.json" 2>/dev/null
echo "$NAME done"
