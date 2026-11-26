#!/usr/bin/env bash
# linux.sh <cap-gpui binary> <work dir>: scripted meetings through the real app on Linux (X11).
#
# The fixture meeting's microphone side plays into a PulseAudio null sink whose monitor is the
# default source, so the app records it through its normal microphone path. The other side comes
# from a stand-in call page in Chrome (served locally, opened at the call address the app's call
# check knows), which holds the microphone like a call does and plays its audio to the default
# speakers, which the app records as computer audio. The account is a Pro account against
# stub_server.py (capabilities, transcription, notes and Ask), never a real Cap server.
#
# Cases: a Local meeting with the notes window open and a question asked through the Ask bar with
# real X input; a Cloud meeting; the live indicator's banner at the right edge of the screen; the
# notes window opened again through its shortcut and a meeting start stays one window, in front.
# Each case writes <work>/<case>/check.txt; the script fails if any check fails.
set -uo pipefail
BIN=$1; WORK=$2
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
FIX=$ROOT/apps/desktop-gpui/tests/fixtures/meetings
MODELS=${CAP_MEETINGS_MODELS:?models dir}
mkdir -p "$WORK"
epoch() { python3 -c 'import time;print(int(time.time()*1000))'; }
shot() { import -window root "$1" 2>/dev/null || true; }

# The meeting's audio as the app and the call page need it.
MEET=$WORK/meeting; mkdir -p "$MEET"
ffmpeg -v error -y -i "$FIX/you.opus" -f f32le -ac 1 -ar 48000 "$MEET/mic.f32"
ffmpeg -v error -y -i "$FIX/others.opus" -ac 1 -ar 48000 -c:a pcm_s16le "$MEET/sys.wav"
cp "$FIX/truth.json" "$MEET/"
DUR=$(python3 -c "import json;print(json.load(open('$MEET/truth.json'))['duration_ms']//1000)")

# Display, audio devices, the call page's certificate.
export DISPLAY=:91
Xvfb $DISPLAY -screen 0 1920x1080x24 -nolisten tcp > "$WORK/xvfb.log" 2>&1 &
pulse_dir=$(mktemp -d)
pulseaudio -n --daemonize=yes --exit-idle-time=-1 \
  -L "module-native-protocol-unix socket=$pulse_dir/native auth-anonymous=1" \
  -L "module-null-sink sink_name=room sink_properties=device.description=Room" \
  -L "module-null-sink sink_name=micsink sink_properties=device.description=MicFeed" \
  -L "module-remap-source master=micsink.monitor source_name=mic source_properties=device.description=Mic"
export PULSE_SERVER=unix:$pulse_dir/native
for _ in $(seq 40); do pactl info > /dev/null 2>&1 && break; sleep 0.25; done
pactl info > /dev/null 2>&1 || { echo "PulseAudio did not start"; exit 1; }
pactl set-default-sink room; pactl set-default-source mic
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -days 2 \
  -subj "/CN=meet.google.com" -addext "subjectAltName=DNS:meet.google.com" 2> /dev/null
CHROME=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium)

start_call() { # <case dir> <start epoch ms>
  python3 "$HERE/call_server.py" "$MEET" 8443 "$1/page_started.log" --tls "$WORK/cert.pem" "$WORK/key.pem" &
  echo $! > "$1/call_server.pid"
  sleep 0.5
  kill -0 "$(cat "$1/call_server.pid")" 2> /dev/null || { echo "the call page server did not start"; exit 1; }
  "$CHROME" --user-data-dir="$1/chrome" --no-first-run --no-default-browser-check --disable-gpu \
    --host-resolver-rules="MAP meet.google.com:443 127.0.0.1:8443" --ignore-certificate-errors \
    --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
    --window-position=0,560 --window-size=900,500 "https://meet.google.com/abc-defg-hij?at=$2" \
    > "$1/chrome.log" 2>&1 &
  echo $! > "$1/chrome.pid"
}
stop_call() {
  kill "$(cat "$1/chrome.pid")" "$(cat "$1/call_server.pid")" 2> /dev/null || true
  pkill -f "user-data-dir=$1/chrome" || true
}

meeting() { # <case> <local|cloud> [ask question]
  local R=$WORK/$1 ENGINE=$2 ASK=${3:-}
  mkdir -p "$R/home" "$R/data/meetings" "$R/shots"
  local M=$R/home/.local/share/so.cap.desktop/transcription_models
  mkdir -p "$M"; for f in "$MODELS"/*; do ln -s "$f" "$M/"; done
  echo "{\"enabled\": true, \"setupCompleted\": true, \"transcription\": {\"engine\": \"$ENGINE\", \"live\": true}}" > "$R/data/meetings/settings.json"
  echo "{\"general_settings\":{\"hasCompletedOnboarding\":true,\"hasCompletedStartup\":true,\"enableNotifications\":false,\"enableTelemetry\":false,\"recordingCountdown\":0,\"serverUrl\":\"http://127.0.0.1:8899\"},\"auth\":{\"secret\":{\"api_key\":\"ci-test-key\"},\"user_id\":\"citestuser0001\",\"plan\":{\"upgraded\":true,\"manual\":false,\"last_checked\":$(date +%s)},\"organizations\":[]}}" > "$R/data/store"
  python3 "$HERE/stub_server.py" 8899 "$R/stub.jsonl" & local STUB=$!
  for _ in $(seq 50); do python3 -c "import socket;socket.create_connection(('127.0.0.1',8899),0.2)" 2> /dev/null && break; sleep 0.1; done
  local SECS=$((DUR + 12)) LINGER=70
  env HOME="$R/home" CAP_GPUI_APP_DATA_DIR="$R/data" CAP_GPUI_NO_TRAY=1 \
    RUST_LOG=warn,cap_gpui=info,cap_meetings=info CAP_GPUI_DOCS_OPEN=live \
    CAP_GPUI_AUTO_MEETING=$SECS CAP_GPUI_AUTO_MEETING_LINGER=$LINGER CAP_GPUI_AUTO_MEETING_OUT="$R/summary.json" \
    CAP_GPUI_AUTO_MEETING_STOP_FILE="$R/page_started.log" \
    "$BIN" < /dev/null > "$R/app.log" 2>&1 &
  local P=$!
  echo "pid $P" > "$R/run.txt"
  for _ in $(seq 900); do grep -qa "CAP_GPUI_AUTO_MEETING: recording" "$R/app.log" && break; kill -0 $P 2> /dev/null || break; sleep 0.1; done
  local AT=$(( $(epoch) + 5000 ))
  start_call "$R" "$AT"
  python3 -c "import time;time.sleep(max(0,$AT/1000-time.time()))"
  echo "mic $(epoch)" >> "$R/run.txt"
  pacat --playback --device=micsink --raw --format=float32le --rate=48000 --channels=1 < "$MEET/mic.f32" &
  local MICP=$!
  sleep $((DUR / 2)); shot "$R/shots/recording.png"
  local asked=
  for _ in $(seq $(( (SECS + LINGER + 240) * 5 ))); do
    [ -s "$R/summary.json" ] && break
    kill -0 $P 2> /dev/null || break
    if [ -z "$asked" ] && grep -qa "CAP_GPUI_AUTO_MEETING: drained" "$R/app.log"; then
      asked=1; sleep 25; shot "$R/shots/notes.png"
      if [ -n "$ASK" ]; then
        # No window manager under Xvfb: focus the window under the pointer before typing.
        xdotool mousemove 1100 880; sleep 0.2
        eval "$(xdotool getmouselocation --shell)"; xdotool windowfocus --sync "$WINDOW" 2> /dev/null
        xdotool click 1; sleep 0.5; xdotool type --delay 30 "$ASK"; sleep 0.3; xdotool key Return
        echo "asked $(epoch)" >> "$R/run.txt"; sleep 6; shot "$R/shots/ask.png"
      fi
    fi
    sleep 0.2
  done
  kill $P $MICP $STUB 2> /dev/null; sleep 1; kill -9 $P 2> /dev/null
  stop_call "$R"
  local DOC
  DOC=$(python3 -c "import json;print(json.load(open('$R/summary.json'))['docDir'])" 2> /dev/null)
  echo "doc $DOC" >> "$R/run.txt"
  python3 "$HERE/offsets.py" "$R" "$DOC" > "$R/offsets.json"
  python3 "$HERE/score.py" "$DOC/transcript.jsonl" "$MEET/truth.json" "$R/offsets.json" > "$R/score.json" 2> "$R/score.err"
  CAP_EXPECT_QUESTION="$ASK" python3 "$HERE/check.py" "$R" "$DOC" "$ENGINE" "$MEET" | tee "$R/check.txt"
}

indicator() { # the live indicator docked at the right edge, under a window manager (openbox):
  # a tour switches it between collapsed and the "call ended" banner six times while its window's
  # root position is sampled; the right edge must stay where it is, on screen.
  local R=$WORK/indicator; mkdir -p "$R/home" "$R/data"
  echo '{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false}}' > "$R/data/store"
  : > "$R/tour.txt"
  for i in 1 2 3 4 5 6; do
    printf 'c%s recording indicator 2500\nb%s ind-ending indicator 2500\n' "$i" "$i" >> "$R/tour.txt"
  done
  openbox > "$R/openbox.log" 2>&1 &
  local WM=$!
  sleep 1
  env HOME="$R/home" CAP_GPUI_APP_DATA_DIR="$R/data" CAP_GPUI_NO_TRAY=1 CAP_GPUI_MEETING_UI="$R/tour.txt" \
    "$BIN" < /dev/null > "$R/app.log" 2>&1 &
  local P=$! id
  sleep 4
  : > "$R/samples.txt"
  for i in $(seq 110); do
    id=$(xwininfo -root -tree 2> /dev/null | grep '"Cap Meeting Indicator"' | grep -oE '^ *0x[0-9a-f]+' | tr -d ' ' | head -1)
    [ -n "$id" ] && xwininfo -id "$id" 2> /dev/null \
      | awk '/Absolute upper-left X/ {x=$4} /Width:/ {w=$2} END {print x, w}' >> "$R/samples.txt"
    [ "$i" = 40 ] && shot "$R/indicator.png"
    sleep 0.3
  done
  kill $P $WM; sleep 1; kill -9 $P 2> /dev/null
  local screen
  screen=$(xwininfo -root | awk '/Width:/ {w=$2} END {print w}')
  python3 - "$R/samples.txt" "$screen" << 'PY' | tee "$R/check.txt"
import sys
rows = [tuple(map(int, l.split())) for l in open(sys.argv[1]) if len(l.split()) == 2]
screen = int(sys.argv[2])
wide = [r for r in rows if r[1] > 200]
rights = {x + w for x, w in rows}
ok = len(wide) >= 3 and len(rows) - len(wide) >= 3 and rights and max(rights) - min(rights) <= 1 \
    and max(rights) <= screen and min(x for x, _ in rows) >= 0
print(("PASS" if ok else "FAIL"), f"right edge {sorted(rights)} on a {screen} px screen over {len(rows)} samples ({len(wide)} with the banner)")
print("ALL_PASS" if ok else "SOME_FAILED")
PY
}

notes_window() { # opening the notes window again (its shortcut, then a meeting start) raises the one
  # that is open, under a window manager: exactly one "Cap Notes" window, and it is the active one.
  local R=$WORK/notes-window; mkdir -p "$R/home" "$R/data/meetings" "$R/shots"
  echo '{"enabled": true, "setupCompleted": true, "transcription": {"engine": "local", "live": true}}' > "$R/data/meetings/settings.json"
  echo '{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"hotkeys":{"hotkeys":{"openMeetingNotes":{"code":"KeyN","meta":false,"ctrl":true,"alt":true,"shift":false},"toggleMeetingNotes":{"code":"KeyY","meta":false,"ctrl":true,"alt":true,"shift":false}}}}' > "$R/data/store"
  local M=$R/home/.local/share/so.cap.desktop/transcription_models
  mkdir -p "$M"; for f in "$MODELS"/*; do ln -s "$f" "$M/"; done
  openbox > "$R/openbox.log" 2>&1 &
  local WM=$!
  sleep 1
  env HOME="$R/home" CAP_GPUI_APP_DATA_DIR="$R/data" CAP_GPUI_NO_TRAY=1 RUST_LOG=warn,cap_gpui=info \
    "$BIN" < /dev/null > "$R/app.log" 2>&1 &
  local P=$!
  sleep 10
  look() {
    local active notes
    notes=$(xwininfo -root -tree | grep -c '"Cap Notes"')
    active=$(xdotool getwindowname "$(xdotool getactivewindow 2> /dev/null)" 2> /dev/null)
    echo "$1 notes=$notes active=$active" >> "$R/states.txt"
  }
  : > "$R/states.txt"
  xdotool key ctrl+alt+n; sleep 3; look open
  local main
  main=$(xdotool search --name '^Cap$' 2> /dev/null | head -1)
  [ -n "$main" ] && xdotool windowactivate "$main" 2> /dev/null; sleep 1
  xdotool key ctrl+alt+n; sleep 3; look open-again
  xdotool key ctrl+alt+y; sleep 4; look meeting
  xdotool key ctrl+alt+y; sleep 2
  shot "$R/shots/notes-window.png"
  kill $P $WM; sleep 1; kill -9 $P 2> /dev/null
  awk '{ ok = ($2 == "notes=1" && $3 == "active=Cap" && $4 == "Notes"); bad += !ok
         print (ok ? "PASS" : "FAIL"), $0 } END { print (bad || NR < 3 ? "SOME_FAILED" : "ALL_PASS") }' \
    "$R/states.txt" | tee "$R/check.txt"
}

meeting local "local" "What did Ana say about the plan?"
meeting cloud "cloud"
indicator
notes_window
failed=0
for c in local cloud indicator notes-window; do
  grep -q ALL_PASS "$WORK/$c/check.txt" 2> /dev/null || { echo "case $c failed"; failed=1; }
done
exit $failed
