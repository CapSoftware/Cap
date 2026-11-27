#!/bin/zsh
# notes_mac.sh <out dir> <bin> [cases]: Cap Notes end to end on the mini with
# the repo's meeting fixture and checker (scripts/ci/meetings). Runs as a
# CapRigLauncher child (mic + screen grants). Case "idle" = Notes off, plain
# launch, 60 s, records whether anything Notes-related runs.
O=$1; BIN=$2; shift 2
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
G=$HOME/gate064
S=$G/meetings
FIX=$G/fixtures
MODELS=$HOME/gate064/models
mkdir -p $O
epoch() { python3 -c 'import time;print(int(time.time()*1000))'; }
IDX=$(ffmpeg -hide_banner -f lavfi -i anullsrc -t 0.1 -f audiotoolbox -list_devices true - 2>&1 | grep -E "BlackHole 2ch" | grep -oE "\[[0-9]+\]" | tail -1 | tr -d "[]")
echo "blackhole audiotoolbox index: $IDX" > $O/env.txt
ffmpeg -v error -y -i $FIX/you.opus -ac 2 -ar 48000 $O/you.wav
ffmpeg -v error -y -i $FIX/others.opus -ac 2 -ar 48000 $O/others.wav
DUR=$(python3 -c "import json;print(json.load(open('$FIX/truth.json'))['duration_ms']//1000)")
for c in "$@"; do
  R=$O/$c; mkdir -p "$R/home/Library/Application Support/so.cap.desktop" "$R/data/meetings"
  ln -s "$MODELS" "$R/home/Library/Application Support/so.cap.desktop/transcription_models"
  ln -s "$MODELS" "$R/data/transcription_models"
  echo "{\"general_settings\":{\"hasCompletedOnboarding\":true,\"hasCompletedStartup\":true,\"enableNotifications\":false,\"enableTelemetry\":false,\"recordingCountdown\":0,\"serverUrl\":\"http://127.0.0.1:8899\"},\"auth\":{\"secret\":{\"api_key\":\"ci-test-key\"},\"user_id\":\"citestuser0001\",\"plan\":{\"upgraded\":true,\"manual\":false,\"last_checked\":$(date +%s)},\"organizations\":[]}}" > "$R/data/store"
  python3 $S/stub_server.py 8899 "$R/stub.jsonl" & STUB=$!
  sleep 1
  if [ $c = idle ]; then
    env HOME="$R/home" CAP_GPUI_APP_DATA_DIR="$R/data" CAP_GPUI_NO_TRAY=1 RUST_LOG=info "$BIN" < /dev/null > "$R/app.log" 2>&1 &
    P=$!
    sleep 60
    ps -o pid,%cpu,rss,command -p $P > "$R/ps.txt"
    lsof -p $P 2>/dev/null | grep -ciE "transcription_models|\.onnx" > "$R/models-open.txt"
    screencapture -x "$R/idle.png"
    kill $P $STUB; sleep 1; kill -9 $P 2>/dev/null
    continue
  fi
  echo "{\"enabled\": true, \"setupCompleted\": true, \"transcription\": {\"engine\": \"local\", \"live\": true}}" > "$R/data/meetings/settings.json"
  SECS=$((DUR + 12)); LINGER=70
  env HOME="$R/home" CAP_GPUI_APP_DATA_DIR="$R/data" CAP_GPUI_NO_TRAY=1 ORT_DYLIB_PATH="$(dirname $BIN)/../onnxruntime/lib/libonnxruntime.dylib" \
    RUST_LOG=warn,cap_gpui=info,cap_meetings=info CAP_GPUI_DOCS_OPEN=live \
    CAP_GPUI_AUTO_MEETING=$SECS CAP_GPUI_AUTO_MEETING_LINGER=$LINGER CAP_GPUI_AUTO_MEETING_OUT="$R/summary.json" \
    "$BIN" < /dev/null > "$R/app.log" 2>&1 &
  P=$!
  for i in $(seq 900); do grep -qa "CAP_GPUI_AUTO_MEETING: recording" "$R/app.log" && break; kill -0 $P 2>/dev/null || break; sleep 0.1; done
  echo "mic $(epoch)" >> "$R/run.txt"
  echo "page $(epoch)" >> "$R/page_started.log"
  ffmpeg -v error -re -i $O/you.wav -f audiotoolbox -audio_device_index $IDX - &
  MICP=$!
  open -n -g -a $G/FilePlayer.app --args $O/others.wav
  sleep $((DUR / 2)); screencapture -x "$R/recording.png"
  for i in $(seq $(( (SECS + LINGER + 240) * 5 ))); do
    [ -s "$R/summary.json" ] && break
    kill -0 $P 2>/dev/null || break
    sleep 0.2
  done
  screencapture -x "$R/notes.png"
  kill $P $MICP $STUB 2>/dev/null; sleep 1; kill -9 $P 2>/dev/null
  pkill -f "FilePlayer.app" 2>/dev/null
  DOC=$(python3 -c "import json;print(json.load(open('$R/summary.json'))['docDir'])" 2>/dev/null)
  echo "doc $DOC" >> "$R/run.txt"
  python3 $S/offsets.py "$R" "$DOC" > "$R/offsets.json" 2> "$R/offsets.err"
  python3 $S/score.py "$DOC/transcript.jsonl" "$FIX/truth.json" "$R/offsets.json" > "$R/score.json" 2> "$R/score.err"
  python3 $S/check.py "$R" "$DOC" local "$FIX" > "$R/check.txt" 2>&1
done
touch $O/DONE
