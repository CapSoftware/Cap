#!/usr/bin/env bash
# proof.sh <out> <base bin> <head bin>: builder CK's scratch Linux proofs for the Greptile round on
# Cap Notes (never shipped). Real app, scratch profiles, a local stub server, null sinks only.
# Phases (CK_PHASES, default "daily handover reader"):
#   daily     one track hits the daily cloud limit while the other track's clip fails as an
#             ordinary server error (daily_stub.py): the engine status at the end, base vs head
#   handover  automatic recording, A records and runs to its end; B starts as A ends and ends
#             3 s later, inside the 5 s countdown (short), or runs on (long): which meetings record
#   reader    PipeWire, music (440 Hz) and a call (880 Hz) on the speakers, the call moves to a
#             headset 25 s in; with Orca speaking and without: tone levels in the meeting's
#             computer audio before and after the move
set -u
OUT=$1; BASE=$2; HEAD=$3
PHASES=${CK_PHASES:-daily handover reader}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
CI=$ROOT/scripts/ci/meetings
FIX=$ROOT/apps/desktop-gpui/tests/fixtures/meetings
mkdir -p "$OUT"
R="$OUT/results.txt"
say() { echo "$(date +%T) $*" | tee -a "$R"; }
wait_file() { local i=0; while [ $i -lt $(( $2 * 2 )) ]; do [ -s "$1" ] && return 0; sleep 0.5; i=$((i + 1)); done; return 1; }
wait_line() { local i=0; while [ $i -lt $(( $3 * 4 )) ]; do grep -qaE "$2" "$1" 2>/dev/null && return 0; sleep 0.25; i=$((i + 1)); done; return 1; }
store() { # <dir>
  echo "{\"general_settings\":{\"hasCompletedOnboarding\":true,\"hasCompletedStartup\":true,\"enableNotifications\":false,\"enableTelemetry\":false,\"recordingCountdown\":0,\"serverUrl\":\"http://127.0.0.1:8899\"},\"auth\":{\"secret\":{\"api_key\":\"ci-test-key\"},\"user_id\":\"citestuser0001\",\"plan\":{\"upgraded\":true,\"manual\":false,\"last_checked\":$(date +%s)},\"organizations\":[]}}" > "$1/store"
}
arm_bin() { case "$1" in base) echo "$BASE";; pre) echo "${CK_PRE_BIN:?}";; *) echo "$HEAD";; esac; }

pulse_up() {
  pulse_dir=$(mktemp -d)
  pulseaudio -n --daemonize=yes --exit-idle-time=-1 \
    -L "module-native-protocol-unix socket=$pulse_dir/native auth-anonymous=1" \
    -L "module-null-sink sink_name=room sink_properties=device.description=Room" \
    -L "module-null-sink sink_name=micsink sink_properties=device.description=MicFeed" \
    -L "module-remap-source master=micsink.monitor source_name=mic source_properties=device.description=Mic"
  export PULSE_SERVER=unix:$pulse_dir/native
  for _ in $(seq 40); do pactl info > /dev/null 2>&1 && break; sleep 0.25; done
  pactl set-default-sink room; pactl set-default-source mic
}
pulse_down() { pulseaudio --kill 2>/dev/null; unset PULSE_SERVER; sleep 1; }

ffmpeg -v error -y -i "$FIX/you.opus" -f f32le -ac 1 -ar 48000 "$OUT/you.f32"
ffmpeg -v error -y -i "$FIX/others.opus" -f f32le -ac 1 -ar 48000 "$OUT/others.f32"
loop_play() { # <file> <sink>: plays forever into a sink
  ( while true; do pacat --playback --device="$2" --raw --format=float32le --rate=48000 --channels=1 < "$1"; done ) > /dev/null 2>&1 < /dev/null &
  echo $!
}

# ---- daily --------------------------------------------------------------------------------------
phase_daily() {
  local MIC OTH
  MIC=$(loop_play "$OUT/you.f32" micsink); OTH=$(loop_play "$OUT/others.f32" room)
  for run in 1 2; do
    for ARM in base head; do
      local TAG="daily-$ARM-$run" D; D=$(mktemp -d); say "start $TAG"
      mkdir -p "$D/meetings" "$D/home" "$D/rec"
      printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "transcription": {"engine": "cloud", "live": true}}' > "$D/meetings/settings.json"
      store "$D"
      python3 "$HERE/daily_stub.py" 8899 "$OUT/$TAG-stub.jsonl" & local STUB=$!
      sleep 1
      env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
        RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_MEETING=100 CAP_GPUI_AUTO_MEETING_OUT="$OUT/$TAG.json" \
        timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
      local P=$!
      wait_line "$OUT/$TAG.log" "CAP_GPUI_AUTO_MEETING: recording" 120
      wait_file "$OUT/$TAG.json" 240 || say "$TAG: no summary"
      sleep 2
      kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
      kill $STUB 2>/dev/null; wait $STUB 2>/dev/null
      python3 - "$OUT/$TAG.json" "$OUT/$TAG-stub.jsonl" "$TAG" >> "$R" << 'PY'
import json, re, sys
s = json.load(open(sys.argv[1])) if __import__("os").path.exists(sys.argv[1]) else {}
engine = ((s.get("beforeStop") or {}).get("active") or {}).get("engine") or ""
cloud = re.search(r"cloud: (\w+)", engine)
issue = re.search(r'issue: (Some\("[^"]*"\)|None)', engine)
rows = [json.loads(l) for l in open(sys.argv[2])]
answers = [r.get("answer") for r in rows if "answer" in r]
print(f"{sys.argv[3]}: engine={engine[:400]!r}")
print(f"{sys.argv[3]}: cloud={cloud.group(1) if cloud else '?'} issue={issue.group(1) if issue else '?'} "
      f"transcribe answers={answers} held_for_second={[r.get('held_for_second') for r in rows if 'held_for_second' in r]}")
PY
      tail -1 "$R"
      find "$D" -delete 2>/dev/null
    done
  done
  kill $MIC $OTH 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
}

# ---- handover -----------------------------------------------------------------------------------
phase_handover() {
  local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
  python3 "$CI/stub_server.py" 8899 "$OUT/handover-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  for VAR in short long; do
    for ARM in base head; do
      local TAG="handover-$VAR-$ARM" D; D=$(mktemp -d); say "start $TAG"
      mkdir -p "$D/meetings" "$D/home" "$D/feed" "$D/rec"
      local BLEN=3; [ $VAR = long ] && BLEN=600
      python3 - "$D/feed/feed.ics" "$BLEN" << 'PY'
import datetime, sys
now = datetime.datetime.now(datetime.timezone.utc)
f = lambda s: (now + datetime.timedelta(seconds=s)).strftime("%Y%m%dT%H%M%SZ")
ev = lambda uid, a, b, t: f"BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:{f(a)}\r\nDTEND:{f(b)}\r\nSUMMARY:{t}\r\nEND:VEVENT\r\n"
blen = int(sys.argv[2])
open(sys.argv[1], "w", newline="").write("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Work\r\n"
    + ev("ck-a", 20, 80, "Meeting A") + ev("ck-b", 80, 80 + blen, "Meeting B") + "END:VCALENDAR\r\n")
PY
      (cd "$D/feed" && exec python3 -m http.server 8787 --bind 127.0.0.1 > /dev/null 2>&1) & local FEED=$!
      printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": true, "detected": false, "leadSecs": 60}, "automation": {"autoRecord": "scheduled", "countdownSecs": 5}, "transcription": {"engine": "cloud", "live": true}}' > "$D/meetings/settings.json"
      printf '%s' '{"sources":[{"id":"ics-ck","name":"Work","config":{"kind":"ics","url":"http://127.0.0.1:8787/feed.ics"},"status":{}}]}' > "$D/meetings/calendars.json"
      store "$D"
      sleep 1
      local T0; T0=$(date +%s)
      env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
        RUST_LOG=warn,cap_gpui=info,cap_meetings=info timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
      local P=$!
      while [ $(( $(date +%s) - T0 )) -lt 50 ]; do sleep 1; done
      say "$TAG at +50 s: $(python3 "$HERE/b2bdocs.py" docs "$D/documents" | sed 's/ files=.*//' | tr '\n' ';')"
      while [ $(( $(date +%s) - T0 )) -lt 110 ]; do sleep 1; done
      say "$TAG at +110 s: $(python3 "$HERE/b2bdocs.py" docs "$D/documents" | sed 's/ files=.*//' | tr '\n' ';')"
      kill $P 2>/dev/null; sleep 4; kill -9 $P 2>/dev/null; wait $P 2>/dev/null; kill $FEED 2>/dev/null
      say "$TAG final: $(python3 "$HERE/b2bdocs.py" docs "$D/documents" | sed 's/ files=.*//' | tr '\n' ';')"
      grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
      find "$D" -delete 2>/dev/null
    done
  done
  kill $MIC $STUB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
}

# ---- reader -------------------------------------------------------------------------------------
pipewire_up() {
  export XDG_RUNTIME_DIR=$(mktemp -d); chmod 700 "$XDG_RUNTIME_DIR"
  export XDG_CONFIG_HOME=$(mktemp -d) XDG_STATE_HOME=$(mktemp -d)
  mkdir -p "$XDG_CONFIG_HOME/wireplumber/bluetooth.lua.d" "$XDG_CONFIG_HOME/wireplumber/main.lua.d"
  echo 'bluez_monitor.enabled = false' > "$XDG_CONFIG_HOME/wireplumber/bluetooth.lua.d/90-ck.lua"
  printf 'stream_defaults = stream_defaults or {}\nstream_defaults["restore-props"] = false\nstream_defaults["restore-target"] = false\n' > "$XDG_CONFIG_HOME/wireplumber/main.lua.d/90-ck-no-restore.lua"
  pipewire > "$OUT/pw.log" 2>&1 & sleep 1
  wireplumber > "$OUT/wp.log" 2>&1 & sleep 1
  pipewire-pulse > "$OUT/pwp.log" 2>&1 & sleep 2
  pactl load-module module-null-sink sink_name=room sink_properties=device.description=Room > /dev/null
  pactl load-module module-null-sink sink_name=headset sink_properties=device.description=Headset > /dev/null
  pactl load-module module-null-sink sink_name=micsink sink_properties=device.description=MicFeed > /dev/null
  pactl load-module module-remap-source master=micsink.monitor source_name=mic source_properties=device.description=Mic > /dev/null
  sleep 1
  pactl set-default-sink room; pactl set-default-source mic
  pactl info | grep -i "server name" | tee -a "$R"
}
ORCA=""
orca_on() {
  gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set \
    org.a11y.Status ScreenReaderEnabled "<true>" > /dev/null 2>&1
  orca --replace >> "$OUT/orca.log" 2>&1 & ORCA=$!; sleep 8
  ( while true; do spd-say -w "Cap reader test one two three four five" > /dev/null 2>&1; sleep 0.5; done ) & SPEAK=$!
}
orca_off() {
  [ -n "${SPEAK:-}" ] && kill $SPEAK 2>/dev/null; SPEAK=""
  [ -n "$ORCA" ] && kill $ORCA 2>/dev/null; pkill -f "orca --replace" 2>/dev/null; ORCA=""
  gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set \
    org.a11y.Status ScreenReaderEnabled "<false>" > /dev/null 2>&1
  sleep 3
}
phase_reader() {
  local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
  python3 "$CI/stub_server.py" 8899 "$OUT/reader-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  for SR in ${CK_SRS:-orca none}; do
    [ $SR = orca ] && orca_on
    for MOVE in ${CK_MOVES:-call music}; do
    for run in $(seq 1 ${CK_RUNS:-2}); do
      for ARM in base head; do
        local TAG="reader-$SR-$MOVE-$ARM-$run" D; D=$(mktemp -d); say "start $TAG"
        mkdir -p "$D/meetings" "$D/home" "$D/rec"
        printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "transcription": {"engine": "cloud", "live": true}}' > "$D/meetings/settings.json"
        store "$D"
        # Music and a call (records the mic, plays a tone) on the speakers.
        PULSE_PROP="application.name=ck-music" ffmpeg -v error -re -f lavfi -i "sine=frequency=440:sample_rate=48000" -af volume=0.3 -f pulse -device room "music" & local MUS=$!
        PULSE_PROP="application.name=ck-call" ffmpeg -v error -f pulse -i mic -re -f lavfi -i "sine=frequency=880:sample_rate=48000" \
          -map 1:a -af volume=0.3 -f pulse -device room "call" -map 0:a -f null - & local CALL=$!
        sleep 2
        env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
          RUST_LOG=warn,cap_gpui=info,cap_gpui::meetings::capture::reader_free=debug CAP_GPUI_AUTO_MEETING=60 CAP_GPUI_AUTO_MEETING_OUT="$OUT/$TAG.json" \
          timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
        local P=$!
        wait_line "$OUT/$TAG.log" "CAP_GPUI_AUTO_MEETING: recording" 120
        local T0; T0=$(date +%s)
        # What the sound server announces during the run, timestamped, from outside the app.
        ( LC_ALL=C pactl subscribe | while IFS= read -r ev; do echo "$(date +%s.%N | cut -c1-14) $ev"; done ) > "$OUT/$TAG-events.txt" 2>&1 &
        local EVL=$!
        sleep 25
        # The call moves (the meeting follows it) or the music moves (the
        # meeting keeps reading the speakers).
        local WHO=$CALL; [ $MOVE = music ] && WHO=$MUS
        # CK_RACE: the music's volume moves (60 changes over about 2 s) while the call moves, so
        # link updates from events and from the follow overlap.
        if [ -n "${CK_RACE:-}" ]; then
          local MUSID; MUSID=$(pactl list sink-inputs | awk '/^Sink Input #/{id=substr($3,2)} /application.process.id = "'$MUS'"/{print id}' | head -1)
          ( for i in $(seq 1 60); do pactl set-sink-input-volume "$MUSID" "$(( 40 + i % 20 ))%"; sleep 0.03; done ) &
          sleep 0.4
        fi
        local ID; ID=$(pactl list sink-inputs | awk '/^Sink Input #/{id=substr($3,2)} /application.process.id = "'$WHO'"/{print id}' | head -1)
        pactl move-sink-input "$ID" headset && say "$TAG moved $MOVE sink-input $ID to headset at +$(( $(date +%s) - T0 )) s"
        ( sleep 3; HS=$(pactl list short sinks | awk '$2=="headset"{print $1}'); ON=$(pactl list short sink-inputs | awk -v id="$ID" '$1==id{print $2}'); [ "$ON" = "$HS" ] && echo "$(date +%T) $TAG move stuck: yes" || echo "$(date +%T) $TAG move stuck: NO (on sink $ON, headset $HS) - run invalid" ) >> "$R" &
        pw-dump > "$OUT/$TAG-after-move.json" 2>/dev/null &
        sleep 30
        pw-dump > "$OUT/$TAG-late.json" 2>/dev/null
        wait_file "$OUT/$TAG.json" 180 || say "$TAG: no summary"
        sleep 1
        pw-dump > "$OUT/$TAG-end.json" 2>/dev/null
        kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
        kill $MUS $CALL 2>/dev/null; wait $MUS $CALL 2>/dev/null
        kill $EVL 2>/dev/null; pkill -P $EVL 2>/dev/null
        grep -a -iE "screen reader|reader-free|follows the call|could not" "$OUT/$TAG.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-220 | tail -12 | sed "s/^/  $TAG log: /" >> "$R"
        python3 - "$OUT/$TAG.json" "$TAG" "$HERE/tones.py" >> "$R" << 'PY'
import json, os, subprocess, sys
s = json.load(open(sys.argv[1])) if os.path.exists(sys.argv[1]) else {}
doc = s.get("docDir") or ""
files = [a["file"] for a in (s.get("audio") or []) if "others" in a["file"]]
for name in files:
    r = subprocess.run(["python3", sys.argv[3], os.path.join(doc, name), "25"], capture_output=True, text=True)
    print(f"{sys.argv[2]}: {r.stdout.strip() or r.stderr.strip()[-200:]}")
if not files:
    print(f"{sys.argv[2]}: no computer audio file ({list((s.get('audio') or []))})")
PY
        tail -2 "$R"
        find "$D" -delete 2>/dev/null
      done
    done
    done
    [ $SR = orca ] && orca_off
  done
  kill $MIC $STUB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
}

# ---- burst --------------------------------------------------------------------------------------
# Orca speaking, the reader-free capture live (music and a call on the speakers, nothing moves).
# 15 s in: a 5 s quiet window, then 100 volume changes on the music stream over about 5 s. Counts
# pw-dump runs (a counting stand-in first in the app's PATH), the app's CPU in each window, and the
# call tone's level per 0.5 s block through the burst.
HZ=$(getconf CLK_TCK)
ticks() { awk '{print $14 + $15}' "/proc/$1/stat" 2>/dev/null || echo 0; }
phase_burst() {
  local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
  python3 "$CI/stub_server.py" 8899 "$OUT/burst-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  orca_on
  for run in 1 2; do
    for ARM in base head; do
      local TAG="burst-${CK_BURST:-stream}-$ARM-$run" D; D=$(mktemp -d); say "start $TAG"
      mkdir -p "$D/meetings" "$D/home" "$D/rec" "$D/bin"
      printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "transcription": {"engine": "cloud", "live": true}}' > "$D/meetings/settings.json"
      store "$D"
      printf '#!/bin/sh\necho x >> "%s"\nexec /usr/bin/pw-dump "$@"\n' "$D/pwdump.count" > "$D/bin/pw-dump"; chmod +x "$D/bin/pw-dump"
      : > "$D/pwdump.count"
      PULSE_PROP="application.name=ck-music" ffmpeg -v error -re -f lavfi -i "sine=frequency=440:sample_rate=48000" -af volume=0.3 -f pulse -device room "music" & local MUS=$!
      PULSE_PROP="application.name=ck-call" ffmpeg -v error -f pulse -i mic -re -f lavfi -i "sine=frequency=880:sample_rate=48000" \
        -map 1:a -af volume=0.3 -f pulse -device room "call" -map 0:a -f null - & local CALL=$!
      sleep 2
      env HOME="$D/home" PATH="$D/bin:$PATH" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
        RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_MEETING=45 CAP_GPUI_AUTO_MEETING_OUT="$OUT/$TAG.json" \
        timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
      local P=$!
      wait_line "$OUT/$TAG.log" "CAP_GPUI_AUTO_MEETING: recording" 120
      local T0 APP; T0=$(date +%s.%N); APP=$(pgrep -P $P | head -1)
      sleep 15
      local MID; MID=$(pactl list sink-inputs | awk '/^Sink Input #/{id=substr($3,2)} /application.process.id = "'$MUS'"/{print id}' | head -1)
      local c0 k0 c1 k1 c2 k2 c3 k3 b0 b1
      c0=$(wc -l < "$D/pwdump.count"); k0=$(ticks $APP)
      sleep 5
      c1=$(wc -l < "$D/pwdump.count"); k1=$(ticks $APP)
      b0=$(python3 -c "import time; print(round(time.time() - $T0, 2))")
      if [ "${CK_BURST:-stream}" = sink ]; then
        for i in $(seq 1 100); do pactl set-sink-volume room "$(( 80 + i % 20 ))%"; sleep 0.04; done
        pactl set-sink-volume room 100%
      else
        for i in $(seq 1 100); do pactl set-sink-input-volume "$MID" "$(( 40 + i % 20 ))%"; sleep 0.04; done
      fi
      b1=$(python3 -c "import time; print(round(time.time() - $T0, 2))")
      c2=$(wc -l < "$D/pwdump.count"); k2=$(ticks $APP)
      sleep 1
      c3=$(wc -l < "$D/pwdump.count"); k3=$(ticks $APP)
      say "$TAG quiet 5 s: pw-dump $((c1 - c0)), cpu $(( (k1 - k0) * 1000 / HZ )) ms | burst 100 changes over $(python3 -c "print(round($b1 - $b0, 1))") s (+1 s): pw-dump $((c3 - c1)), cpu $(( (k3 - k1) * 1000 / HZ )) ms | pw-dump total so far $c3"
      wait_file "$OUT/$TAG.json" 180 || say "$TAG: no summary"
      sleep 1
      kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
      kill $MUS $CALL 2>/dev/null; wait $MUS $CALL 2>/dev/null
      python3 - "$OUT/$TAG.json" "$TAG" "$HERE/burst.py" "$b0" "$b1" >> "$R" << 'PY'
import json, os, subprocess, sys
s = json.load(open(sys.argv[1])) if os.path.exists(sys.argv[1]) else {}
doc = s.get("docDir") or ""
files = [a["file"] for a in (s.get("audio") or []) if "others" in a["file"]]
for name in files:
    r = subprocess.run(["python3", sys.argv[3], os.path.join(doc, name), sys.argv[4], sys.argv[5]], capture_output=True, text=True)
    print(f"{sys.argv[2]}: {r.stdout.strip() or r.stderr.strip()[-200:]}")
cs = (s.get("beforeStop") or {}).get("captureStats") or {}
print(f"{sys.argv[2]}: capture {json.dumps(cs.get('system') or cs)[:300]}")
PY
      tail -2 "$R"
      grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
      find "$D" -delete 2>/dev/null
    done
  done
  orca_off
  kill $MIC $STUB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
}

# ---- sidebar ------------------------------------------------------------------------------------
# Settings open on General, signed out, Orca on: the AT-SPI tree of the Settings window, then presses
# (AT-SPI actions, what Orca does on Enter) on Sign In and View previous versions: the button turns
# into Cancel sign in and the URLs reach the (stand-in) browser.
phase_sidebar() {
  python3 "$HERE/signin_stub.py" 8899 "$OUT/sidebar-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  orca_on
  for ARM in base head; do
    local TAG="sidebar-$ARM" D; D=$(mktemp -d); say "start $TAG"
    mkdir -p "$D/meetings" "$D/home" "$D/rec" "$D/bin"
    printf '%s' '{"enabled": true, "setupCompleted": true}' > "$D/meetings/settings.json"
    echo '{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0,"serverUrl":"http://127.0.0.1:8899"}}' > "$D/store"
    printf '#!/bin/sh\necho "$1" >> "%s"\n' "$D/opened-url" > "$D/bin/xdg-open"; chmod +x "$D/bin/xdg-open"
    env HOME="$D/home" PATH="$D/bin:$PATH" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
      RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_SETTINGS=general \
      timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
    local P=$!
    sleep 12
    local APP; APP=$(pgrep -P $P | head -1)
    python3 "$HERE/atspi.py" tree "$APP" > "$OUT/$TAG-tree.txt" 2>&1
    say "$TAG tree: $(tail -1 "$OUT/$TAG-tree.txt")"
    for name in "Click to sign in" "View previous versions" "Check for updates" "Sign In"; do
      say "$TAG reaches '$name': $(grep -c "| $name |" "$OUT/$TAG-tree.txt") ($(grep "| $name |" "$OUT/$TAG-tree.txt" | head -1 | sed 's/^ *//' | cut -d'|' -f1))"
    done
    say "$TAG press Sign In: $(python3 "$HERE/atspi.py" press "$APP" '^Sign In$' 2>/dev/null | head -1)"
    sleep 3
    python3 "$HERE/atspi.py" tree "$APP" > "$OUT/$TAG-tree-after.txt" 2>&1
    say "$TAG after press: Cancel Sign In node $(grep -ci "| cancel sign in |" "$OUT/$TAG-tree-after.txt"), opened: $(sed 's/[?].*//' "$D/opened-url" 2>/dev/null | tr '\n' ' ')"
    say "$TAG press View previous versions: $(python3 "$HERE/atspi.py" press "$APP" '^View previous versions$' 2>/dev/null | head -1)"
    sleep 2
    say "$TAG opened now: $(sed 's/[?].*//' "$D/opened-url" 2>/dev/null | tr '\n' ' ')"
    import -window root "$OUT/$TAG.png" 2>/dev/null
    kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
    grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
    find "$D" -delete 2>/dev/null
  done
  orca_off
  kill $STUB 2>/dev/null
}

# ---- restart ------------------------------------------------------------------------------------
# The sound server restarts 20 s into a meeting (PipeWire, WirePlumber and the Pulse server), the
# sinks and the call and music streams come back; with Orca speaking and without. The call tone
# (880 Hz) before the restart and from 40 to 70 s shows whether computer audio came back.
audio_restart() {
  pkill -x pipewire-pulse; pkill -x wireplumber; pkill -x pipewire; sleep 2
  pipewire >> "$OUT/pw.log" 2>&1 & sleep 1
  wireplumber >> "$OUT/wp.log" 2>&1 & sleep 1
  pipewire-pulse >> "$OUT/pwp.log" 2>&1 & sleep 2
  pactl load-module module-null-sink sink_name=room sink_properties=device.description=Room > /dev/null
  pactl load-module module-null-sink sink_name=headset sink_properties=device.description=Headset > /dev/null
  pactl load-module module-null-sink sink_name=micsink sink_properties=device.description=MicFeed > /dev/null
  pactl load-module module-remap-source master=micsink.monitor source_name=mic source_properties=device.description=Mic > /dev/null
  sleep 1; pactl set-default-sink room; pactl set-default-source mic
}
phase_restart() {
  for SR in orca none; do
    for ARM in base head; do
      local TAG="restart-$SR-$ARM" D; D=$(mktemp -d); say "start $TAG"
      [ $SR = orca ] && orca_on
      local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
      python3 "$CI/stub_server.py" 8899 "$OUT/restart-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
      mkdir -p "$D/meetings" "$D/home" "$D/rec"
      printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "transcription": {"engine": "cloud", "live": true}}' > "$D/meetings/settings.json"
      store "$D"
      PULSE_PROP="application.name=ck-call" ffmpeg -v error -re -f lavfi -i "sine=frequency=880:sample_rate=48000" -af volume=0.3 -f pulse -device room "call" & local CALL=$!
      sleep 2
      env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
        RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_MEETING=75 CAP_GPUI_AUTO_MEETING_OUT="$OUT/$TAG.json" \
        timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
      local P=$!
      wait_line "$OUT/$TAG.log" "CAP_GPUI_AUTO_MEETING: recording" 120
      sleep 20
      kill $CALL $MIC 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
      [ $SR = orca ] && orca_off
      audio_restart
      say "$TAG sound server restarted"
      [ $SR = orca ] && orca_on
      MIC=$(loop_play "$OUT/you.f32" micsink)
      PULSE_PROP="application.name=ck-call" ffmpeg -v error -re -f lavfi -i "sine=frequency=880:sample_rate=48000" -af volume=0.3 -f pulse -device room "call" & CALL=$!
      wait_file "$OUT/$TAG.json" 240 || say "$TAG: no summary"
      sleep 1; kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
      kill $CALL $MIC $STUB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
      grep -a -iE "reader-free|screen reader|monitor|reopening|could not" "$OUT/$TAG.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-200 | tail -8 | sed "s/^/  $TAG log: /" >> "$R"
      python3 - "$OUT/$TAG.json" "$TAG" "$HERE/tones.py" >> "$R" << 'PY'
import json, os, subprocess, sys
s = json.load(open(sys.argv[1])) if os.path.exists(sys.argv[1]) else {}
doc = s.get("docDir") or ""
files = [a["file"] for a in (s.get("audio") or []) if "others" in a["file"]]
for name in files:
    r = subprocess.run(["python3", sys.argv[3], os.path.join(doc, name), "20"], capture_output=True, text=True)
    print(f"{sys.argv[2]}: call880 before = 3-18 s, after = 26 s to the end: {r.stdout.strip() or r.stderr.strip()[-200:]}")
if not files:
    print(f"{sys.argv[2]}: no computer audio file")
PY
      grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
      [ $SR = orca ] && orca_off
      find "$D" -delete 2>/dev/null
    done
  done
}

# ---- voicepage ----------------------------------------------------------------------------------
# Automatic recording of detected calls on, a calendar meeting starting in 60 s, and Chrome opening
# a local page that only takes the microphone (title "Voice notes"; nothing marks it a meeting).
# Does Cap start recording on its own in the next 35 s?
phase_voicepage() {
  local CHROME; CHROME=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)
  [ -z "$CHROME" ] && { say "voicepage: no Chrome on this runner"; return; }
  python3 "$CI/stub_server.py" 8899 "$OUT/voice-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  local PAGE; PAGE=$(mktemp -d); cp "$HERE/voice.html" "$PAGE/"
  (cd "$PAGE" && exec python3 -m http.server 8445 --bind 127.0.0.1 > /dev/null 2>&1) & local WEB=$!
  local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
  for ARM in ${CK_ARMS:-base head}; do
    local TAG="voicepage-$ARM" D; D=$(mktemp -d); say "start $TAG"
    mkdir -p "$D/meetings" "$D/home" "$D/feed" "$D/rec"
    python3 - "$D/feed/feed.ics" << 'PY'
import datetime, sys
now = datetime.datetime.now(datetime.timezone.utc)
f = lambda s: (now + datetime.timedelta(seconds=s)).strftime("%Y%m%dT%H%M%SZ")
open(sys.argv[1], "w", newline="").write("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Work\r\n"
    f"BEGIN:VEVENT\r\nUID:ck-plan\r\nDTSTART:{f(75)}\r\nDTEND:{f(1875)}\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
PY
    (cd "$D/feed" && exec python3 -m http.server 8787 --bind 127.0.0.1 > /dev/null 2>&1) & local FEED=$!
    printf '%s' "{\"enabled\": true, \"setupCompleted\": true, \"notifications\": {\"scheduled\": false, \"detected\": true}, \"automation\": {\"autoRecord\": \"${CK_AUTO:-detected}\", \"countdownSecs\": 5}, \"transcription\": {\"engine\": \"cloud\", \"live\": true}}" > "$D/meetings/settings.json"
    printf '%s' '{"sources":[{"id":"ics-ck","name":"Work","config":{"kind":"ics","url":"http://127.0.0.1:8787/feed.ics"},"status":{}}]}' > "$D/meetings/calendars.json"
    store "$D"
    env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
      RUST_LOG=warn,cap_gpui=info,cap_meetings=info \
      timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
    local P=$!
    sleep 15
    local C
    if [ "${CK_PAGE:-voice}" = zoom ]; then
      mkdir -p "$D/zoombin"; cp "$(command -v ffmpeg)" "$D/zoombin/zoom"
      "$D/zoombin/zoom" -v error -f pulse -i mic -re -f lavfi -i "sine=frequency=880:sample_rate=48000" \
        -map 1:a -af volume=0.3 -f pulse -device room "call" -map 0:a -f null - > /dev/null 2>&1 &
      C=$!
      say "$TAG a recognised call app (zoom) started (meeting starts in about 60 s)"
    else
      "$CHROME" --user-data-dir="$D/chrome" --no-first-run --no-default-browser-check --disable-gpu \
        --use-fake-ui-for-media-stream --window-position=0,560 --window-size=700,400 \
        "http://127.0.0.1:8445/voice.html" > "$D/chrome.log" 2>&1 &
      C=$!
      say "$TAG Chrome opened the voice page (meeting starts in about 60 s)"
    fi
    if [ -n "${CK_PAGE_STOP:-}" ]; then
      ( sleep "$CK_PAGE_STOP"; kill $C 2>/dev/null; pkill -f "user-data-dir=$D/chrome" 2>/dev/null; echo "$(date +%T) $TAG the page stopped using the microphone" >> "$R" ) &
    fi
    sleep 35
    say "$TAG (autoRecord ${CK_AUTO:-detected}) 35 s later, before the meeting: $(python3 "$HERE/b2bdocs.py" docs "$D/documents" | sed 's/ files=.*//' | tr '\n' ';')"
    sleep ${CK_VOICE_AFTER:-0}
    [ "${CK_VOICE_AFTER:-0}" -gt 0 ] && say "$TAG (autoRecord ${CK_AUTO:-detected}) after the meeting started: $(python3 "$HERE/b2bdocs.py" docs "$D/documents" | sed 's/ files=.*//' | tr '\n' ';')"
    grep -a -iE "detected|prompt|recording|meeting" "$OUT/$TAG.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-180 | tail -6 | sed "s/^/  $TAG log: /" >> "$R"
    import -window root "$OUT/$TAG.png" 2>/dev/null
    kill $C 2>/dev/null; pkill -f "user-data-dir=$D/chrome" 2>/dev/null; pkill -f "$D/zoombin/zoom" 2>/dev/null
    kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null; kill $FEED 2>/dev/null
    grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
    find "$D" -delete 2>/dev/null
  done
  kill $MIC $STUB $WEB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
  find "$PAGE" -delete 2>/dev/null
}

# ---- destroy ------------------------------------------------------------------------------------
# Orca speaking, a call (880 Hz) on the speakers, the meeting reading through the reader-free
# capture; 20 s in, Cap's capture node is destroyed (as a crash of the sound server's side of it
# would). Does computer audio come back?
phase_destroy() {
  orca_on
  local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
  python3 "$CI/stub_server.py" 8899 "$OUT/destroy-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  for run in 1 2; do
    for ARM in base head; do
      local TAG="destroy-$ARM-$run" D; D=$(mktemp -d); say "start $TAG"
      mkdir -p "$D/meetings" "$D/home" "$D/rec"
      printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "transcription": {"engine": "cloud", "live": true}}' > "$D/meetings/settings.json"
      store "$D"
      PULSE_PROP="application.name=ck-call" ffmpeg -v error -re -f lavfi -i "sine=frequency=880:sample_rate=48000" -af volume=0.3 -f pulse -device room "call" & local CALL=$!
      sleep 2
      env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
        RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_MEETING=75 CAP_GPUI_AUTO_MEETING_OUT="$OUT/$TAG.json" \
        timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
      local P=$!
      wait_line "$OUT/$TAG.log" "CAP_GPUI_AUTO_MEETING: recording" 120
      sleep 20
      # pw-dump can print a second document when the graph changes while it dumps: the first is
      # the whole graph.
      local NID; NID=$(pw-dump 2>/dev/null | python3 -c 'import json,sys; g=json.JSONDecoder().raw_decode(sys.stdin.read().lstrip())[0]; print(next((o["id"] for o in g if ((o.get("info") or {}).get("props") or {}).get("node.name")=="cap-meeting-reader-free"), ""))')
      if [ -n "$NID" ] && pw-cli destroy "$NID" > /dev/null 2>&1; then say "$TAG destroyed the reader-free capture node $NID"; else say "$TAG: INVALID, no reader-free node destroyed ($NID)"; fi
      wait_file "$OUT/$TAG.json" 240 || say "$TAG: no summary"
      sleep 1; kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
      kill $CALL 2>/dev/null; wait $CALL 2>/dev/null
      grep -a -iE "reader-free|screen reader|could not" "$OUT/$TAG.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-200 | tail -6 | sed "s/^/  $TAG log: /" >> "$R"
      python3 - "$OUT/$TAG.json" "$TAG" "$HERE/tones.py" >> "$R" << 'PY'
import json, os, subprocess, sys
s = json.load(open(sys.argv[1])) if os.path.exists(sys.argv[1]) else {}
doc = s.get("docDir") or ""
files = [a["file"] for a in (s.get("audio") or []) if "others" in a["file"]]
for name in files:
    r = subprocess.run(["python3", sys.argv[3], os.path.join(doc, name), "20"], capture_output=True, text=True)
    print(f"{sys.argv[2]}: call880 before = 3-18 s, after = 26 s to the end: {r.stdout.strip() or r.stderr.strip()[-200:]}")
if not files:
    print(f"{sys.argv[2]}: no computer audio file")
PY
      grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
      find "$D" -delete 2>/dev/null
    done
  done
  orca_off
  kill $MIC $STUB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
}

# ---- resume -------------------------------------------------------------------------------------
# Two remote voices (fixture others: speakers 5142 then 1995 in the first 50 s) on the computer
# audio, local engine with speaker labels, the computer sleeps at 55 s for 5 s and the meeting is
# resumed. From the saved transcript: every speaker-number record, and each utterance's speaker
# before and after the sleep, so a number dropped for a voice whose lines are still there shows.
phase_resume() {
  local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
  local OTH; OTH=$(loop_play "$OUT/others.f32" room)
  python3 "$CI/stub_server.py" 8899 "$OUT/resume-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  for ARM in base head; do
    local TAG="resume-$ARM" D; D=$(mktemp -d); say "start $TAG"
    mkdir -p "$D/meetings" "$D/home" "$D/rec"
    local M=$D/home/.local/share/so.cap.desktop/transcription_models
    mkdir -p "$M"; for f in "$CK_MODELS"/*; do ln -s "$f" "$M/"; done
    printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "transcription": {"engine": "local", "live": true}}' > "$D/meetings/settings.json"
    store "$D"
    env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
      RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_MEETING=110 CAP_GPUI_AUTO_MEETING_SLEEP=55:5:resume \
      CAP_GPUI_AUTO_MEETING_LINGER=40 CAP_GPUI_AUTO_MEETING_OUT="$OUT/$TAG.json" \
      timeout -k 10 400 "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
    local P=$!
    wait_file "$OUT/$TAG.json" 380 || say "$TAG: no summary"
    sleep 2; kill $P 2>/dev/null; sleep 2; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
    grep -a -E "going to sleep|woke|resumed" "$OUT/$TAG.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-160 | sed "s/^/  $TAG log: /" >> "$R"
    local DOC; DOC=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("docDir") or "")' "$OUT/$TAG.json" 2>/dev/null)
    [ -n "$DOC" ] && cp "$DOC/transcript.jsonl" "$OUT/$TAG-transcript.jsonl" 2>/dev/null
    python3 - "$OUT/$TAG-transcript.jsonl" "$TAG" >> "$R" << 'PY'
import json, sys
tag = sys.argv[2]
try:
    lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except Exception as e:
    print(f"{tag}: no transcript ({e})"); sys.exit()
names = [l for l in lines if "speakerNames" in json.dumps(l)[:40] or "numbers" in json.dumps(l)]
for n in names[-4:]:
    print(f"{tag}: names {json.dumps(n)[:400]}")
utts = {}
for l in lines:
    u = l.get("utterance") if isinstance(l, dict) else None
    u = u or (l if isinstance(l, dict) and "speakerId" in l else None)
    if u and u.get("source") == "system":
        utts[u.get("id")] = u
for u in sorted(utts.values(), key=lambda u: u.get("startMs", 0)):
    print(f"{tag}: system utt {u.get('startMs')}-{u.get('endMs')} speakerId={u.get('speakerId')} speaker={u.get('speaker')} final={u.get('isFinal')}")
PY
    grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
    find "$D" -delete 2>/dev/null
  done
  kill $MIC $OTH $STUB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
}

# ---- signin -------------------------------------------------------------------------------------
# Account A records a meeting with automatic notes off; its notes are left unwritten for A. Cap then
# starts signed out (automatic notes on), the person signs in as A through the real flow (Sign In
# pressed through AT-SPI, the opened URL caught by a stand-in xdg-open, the loopback callback
# answered with A's key): are A's notes written now, without a restart?
phase_signin() {
  local MIC; MIC=$(loop_play "$OUT/you.f32" micsink)
  python3 "$HERE/signin_stub.py" 8899 "$OUT/signin-stub.jsonl" > /dev/null 2>&1 & local STUB=$!
  sleep 1
  local P0; P0=$(mktemp -d); mkdir -p "$P0/meetings" "$P0/home" "$P0/rec"
  printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "notes": {"autoGenerate": false}, "transcription": {"engine": "cloud", "live": true}}' > "$P0/meetings/settings.json"
  store "$P0"
  say "start signin-setup"
  env HOME="$P0/home" CAP_GPUI_APP_DATA_DIR="$P0" CAP_GPUI_RECORDINGS_DIR="$P0/rec" CAP_GPUI_NO_TRAY=1 \
    RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_MEETING=20 CAP_GPUI_AUTO_MEETING_OUT="$OUT/signin-setup.json" \
    timeout -k 10 200 "$HEAD" < /dev/null > "$OUT/signin-setup.log" 2>&1 &
  local P=$!
  wait_file "$OUT/signin-setup.json" 200 || say "signin-setup: no summary"
  sleep 3; kill $P 2>/dev/null; sleep 2; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
  local DOC; DOC=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("docId",""))' "$OUT/signin-setup.json" 2>/dev/null)
  say "signin-setup doc=$DOC notes requests so far=$(grep -c '"/api/desktop/meetings/notes"' "$OUT/signin-stub.jsonl")"
  printf '[{"id": "%s", "account": "citestuser0001"}]' "$DOC" > "$P0/meetings/unwritten-notes.json"
  orca_on
  for ARM in base head; do
  for WHO in b a; do
    local ACCT=citestuser0001; [ $WHO = b ] && ACCT=citestuserbbbb
    local TAG="signin-as-$WHO-$ARM" D; D=$(mktemp -d); say "start $TAG"
    cp -R "$P0/." "$D/"
    printf '%s' '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false}, "notes": {"autoGenerate": true}, "transcription": {"engine": "cloud", "live": true}}' > "$D/meetings/settings.json"
    echo '{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0,"serverUrl":"http://127.0.0.1:8899"}}' > "$D/store"
    mkdir -p "$D/bin"
    printf '#!/bin/sh\necho "$1" >> "%s"\n' "$D/opened-url" > "$D/bin/xdg-open"; chmod +x "$D/bin/xdg-open"
    local N0; N0=$(grep -c '"/api/desktop/meetings/notes"' "$OUT/signin-stub.jsonl")
    env HOME="$D/home" PATH="$D/bin:$PATH" CAP_GPUI_APP_DATA_DIR="$D" CAP_GPUI_RECORDINGS_DIR="$D/rec" CAP_GPUI_NO_TRAY=1 \
      RUST_LOG=warn,cap_gpui=info CAP_GPUI_AUTO_SETTINGS=general \
      timeout -k 10 ${CK_RUN_CAP:-300} "$(arm_bin $ARM)" < /dev/null > "$OUT/$TAG.log" 2>&1 &
    P=$!
    sleep 12
    local APP; APP=$(pgrep -P $P | head -1)
    say "$TAG signed out at start: unwritten=$(cat "$D/meetings/unwritten-notes.json" 2>/dev/null) notes requests=$(( $(grep -c '"/api/desktop/meetings/notes"' "$OUT/signin-stub.jsonl") - N0 ))"
    local PRESS; PRESS=$(python3 "$HERE/atspi.py" press "$APP" '^Sign In$' 2>/dev/null | head -1)
    if [ -n "$PRESS" ]; then
      say "$TAG AT-SPI: $PRESS"
    else
      python3 "$HERE/atspi.py" tree "$APP" > "$OUT/$TAG-tree.txt" 2>&1
      xdotool mousemove 930 770 click 1
      say "$TAG: no 'Sign In' node through AT-SPI, clicked its place (930,770)"
    fi
    wait_file "$D/opened-url" 20 || say "$TAG: no URL opened"
    local URL PORT; URL=$(head -1 "$D/opened-url" 2>/dev/null); PORT=$(echo "$URL" | sed -n 's/.*[?&]port=\([0-9]*\).*/\1/p')
    say "$TAG opened $(echo "$URL" | sed 's/[?].*//') port=$PORT"
    [ -n "$PORT" ] && curl -s -o /dev/null -w "$TAG callback %{http_code}\n" "http://127.0.0.1:$PORT/?api_key=ci-test-key&user_id=$ACCT" | tee -a "$R"
    sleep 40
    say "$TAG 40 s after sign-in: unwritten=$(cat "$D/meetings/unwritten-notes.json" 2>/dev/null || echo gone) notes requests=$(( $(grep -c '"/api/desktop/meetings/notes"' "$OUT/signin-stub.jsonl") - N0 ))"
    say "$TAG docs: $(python3 "$HERE/b2bdocs.py" docs "$D/documents" | sed 's/ files=.*//' | tr '\n' ';')"
    python3 -c 'import json,sys,os; m=json.load(open(sys.argv[1])).get("meeting") or {}; print(sys.argv[2], "has_enhanced", m.get("hasEnhanced"), "enhanced file", os.path.exists(os.path.join(os.path.dirname(sys.argv[1]), "enhanced.json")))' "$D/documents/$DOC/doc.json" "$TAG" 2>&1 | tee -a "$R"
    import -window root "$OUT/$TAG.png" 2>/dev/null
    kill $P 2>/dev/null; sleep 3; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
    grep -ac "panicked" "$OUT/$TAG.log" | sed "s/^/$TAG panics: /" | tee -a "$R"
    grep -a -iE "notes for a meeting that ended|sign" "$OUT/$TAG.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-200 | sed "s/^/  $TAG log: /" >> "$R"
    find "$D" -delete 2>/dev/null
  done
  done
  orca_off
  kill $MIC $STUB 2>/dev/null; pkill -f "pacat --playback" 2>/dev/null
  find "$P0" -delete 2>/dev/null
}

pipewire_up
for PH in $PHASES; do
  say "== phase $PH"
  "phase_$PH"
done
say "== done"
