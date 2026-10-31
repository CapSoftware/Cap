#!/usr/bin/env bash
# Usage: x11-capture.sh <cap-gpui> <ffmpeg lib dir> <out-dir>
set -uo pipefail
for tool in Xvfb xdotool xmessage pulseaudio pactl paplay ffmpeg; do
  command -v "$tool" >/dev/null ||
    { echo "install xvfb, xdotool, x11-utils, pulseaudio, pulseaudio-utils and ffmpeg" >&2; exit 2; }
done
if [[ -z ${X11_CAPTURE_BUS:-} ]]; then
  exec env X11_CAPTURE_BUS=1 dbus-run-session -- bash "$0" "$@"
fi
bin=$1 libs=$2 out=$3
mkdir -p "$out" && : >"$out/result.txt" || { echo "x11-capture: cannot write to $out" >&2; exit 2; }
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
unset WAYLAND_DISPLAY
export DISPLAY=:79 XDG_SESSION_TYPE=x11
Xvfb "$DISPLAY" -screen 0 1920x1080x24 >/dev/null 2>&1 &
xvfb=$!
sleep 1
xmessage -geometry 480x270+700+300 -title "Window to record" "A window to record" >/dev/null 2>&1 &
other=$!

pulse_dir=$(mktemp -d)
export PULSE_SERVER=unix:$pulse_dir/native
pulseaudio -n --daemonize=no --exit-idle-time=-1 --log-target=stderr \
  -L "module-native-protocol-unix socket=$pulse_dir/native auth-anonymous=1" \
  -L "module-null-sink sink_name=cap_tone" \
  -L "module-remap-source master=cap_tone.monitor source_name=cap_mic" >"$out/pulse.log" 2>&1 &
pulse=$!
for _ in $(seq 40); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
pactl set-default-sink cap_tone
pactl set-default-source cap_mic
python3 - "$out/tone.wav" <<'PY'
import math
import struct
import sys
import wave

rate = 48000
with wave.open(sys.argv[1], "wb") as tone:
    tone.setnchannels(2)
    tone.setsampwidth(2)
    tone.setframerate(rate)
    tone.writeframes(b"".join(
        struct.pack("<hh", sample, sample)
        for sample in (int(12000 * math.sin(2 * math.pi * 440 * n / rate)) for n in range(rate * 30))
    ))
PY
(while paplay --device=cap_tone "$out/tone.wav"; do :; done) &
player=$!
trap 'pkill -P $player 2>/dev/null; kill $player $pulse $other $xvfb 2>/dev/null' EXIT

mp4_info() {
  python3 - "$1" <<'PY'
import struct
import sys

data = open(sys.argv[1], "rb").read()


def boxes(start, end):
    while start + 8 <= end:
        size, kind = struct.unpack(">I4s", data[start : start + 8])
        header = 8
        if size == 1:
            size = struct.unpack(">Q", data[start + 8 : start + 16])[0]
            header = 16
        elif size == 0:
            size = end - start
        if size < header:
            return
        yield kind, start + header, start + size
        start += size


seconds = width = height = None
for kind, body, end in boxes(0, len(data)):
    if kind != b"moov":
        continue
    for inner, inner_body, inner_end in boxes(body, end):
        if inner == b"mvhd":
            if data[inner_body] == 1:
                scale, duration = struct.unpack(">IQ", data[inner_body + 20 : inner_body + 32])
            else:
                scale, duration = struct.unpack(">II", data[inner_body + 12 : inner_body + 20])
            seconds = duration / scale if scale else None
        if inner == b"trak" and width is None:
            for track, track_body, _ in boxes(inner_body, inner_end):
                if track == b"tkhd":
                    offset = track_body + (88 if data[track_body] == 1 else 76)
                    w, h = struct.unpack(">II", data[offset : offset + 8])
                    if w and h:
                        width, height = w >> 16, h >> 16
if seconds is not None:
    print(f"{seconds:.2f} {width} {height}")
PY
}

png_size() {
  python3 -c 'import struct, sys
data = open(sys.argv[1], "rb").read(24)
if data[:8] == b"\x89PNG\r\n\x1a\n":
    print(*struct.unpack(">II", data[16:24]))' "$1"
}

launch() {
  local name=$1; shift
  local profile=$out/$name
  mkdir -p "$profile/recordings" "$profile/logs"
  printf '%s' '{"general_settings":{"hasCompletedStartup":true,"hasCompletedOnboarding":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"recording_start_safety":{"confirmBeforeRecordingWithoutMicrophone":false}}' >"$profile/store"
  env LD_LIBRARY_PATH="$libs" CAP_GPUI_APP_DATA_DIR="$profile" CAP_GPUI_RECORDINGS_DIR="$profile/recordings" \
    CAP_GPUI_LOG_DIR="$profile/logs" CAP_GPUI_NO_TRAY=1 CAP_GPUI_AUTO_NO_MIC=1 RUST_LOG=info "$@" \
    "$bin" >"$profile/cap.log" 2>&1 &
  echo $! >"$profile/pid"
}

wait_log() {
  local log=$1 pattern=$2 seconds=$3
  for _ in $(seq $((seconds * 4))); do
    grep -aq -- "$pattern" "$log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

finish() {
  local name=$1 pid
  pid=$(cat "$out/$name/pid")
  result "${name}_cap_alive" "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
  result "${name}_panics" "$(grep -ac 'panicked at' "$out/$name/cap.log")"
  kill "$pid" 2>/dev/null
  for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null
}

record() {
  local name=$1 want_width=$2 want_height=$3 shortcut=$4; shift 4
  local log=$out/$name/cap.log
  launch "$name" "$@"
  if [[ $shortcut == yes ]]; then
    wait_log "$log" "auto-record start requested" 30
    sleep 2
    xdotool key ctrl+shift+F9
  fi
  local started=no finished=no
  wait_log "$log" "recording started" 20 && started=yes
  if [[ $started == yes && $shortcut == yes ]]; then
    sleep 4
    xdotool key ctrl+shift+F9
  fi
  # Well before the 60 s automatic stop of the shortcut cases, so a Stop
  # shortcut that does not work fails here.
  wait_log "$log" "recording finished" 15 && finished=yes
  sleep 2
  result "${name}_started" "$started"
  result "${name}_finished" "$finished"
  local project video info
  project=$(find "$out/$name/recordings" -maxdepth 1 -name "*.cap" | head -1)
  # A finish keeps its recovery workspace by design; the backup of the media
  # it replaced must be gone.
  result "${name}_backup_left" "$(find "$out/$name/recordings" -path '*/.recovery-*/original-segments' 2>/dev/null | wc -l)"
  video=$(find "${project:-/nonexistent}" -path "*segment-0/display.mp4" 2>/dev/null | head -1)
  info=$( [[ -n $video ]] && mp4_info "$video")
  echo "$name: ${video:-no display.mp4} ${info:-}" >>"$out/actions.log"
  read -r seconds width height <<<"${info:-0 0 0}"
  result "${name}_video" "$(awk -v s="$seconds" -v w="$width" -v h="$height" -v W="$want_width" -v H="$want_height" \
    'BEGIN { print (s >= 3 && s <= 10 && w == W && h == H ? "yes" : "no") }')"
  finish "$name"
}

record display 1920 1080 yes CAP_GPUI_AUTO_RECORD=studio:60
record area 640 360 yes CAP_GPUI_AUTO_RECORD=studio:60 CAP_GPUI_AUTO_OVERLAY=area CAP_GPUI_AUTO_AREA=100,100,640,360
record window 480 270 no CAP_GPUI_AUTO_RECORD=studio:6 CAP_GPUI_AUTO_OVERLAY=window \
  CAP_GPUI_AUTO_WINDOW="Window to record"
record audio 480 270 no CAP_GPUI_AUTO_RECORD=studio:6 CAP_GPUI_AUTO_OVERLAY=window \
  CAP_GPUI_AUTO_WINDOW="Window to record" CAP_GPUI_AUTO_NO_MIC=0 CAP_GPUI_AUTO_SYSTEM_AUDIO=1
# Both tracks span the recording: as long as its video, give or take half a
# second.
audio_video=$(find "$out/audio/recordings" -path "*segment-0/display.mp4" 2>/dev/null | head -1)
read -r audio_video_seconds _ <<<"$( [[ -n $audio_video ]] && mp4_info "$audio_video")"
for track in audio-input system_audio; do
  file=$(find "$out/audio/recordings" -path "*segment-0/$track.m4a" 2>/dev/null | head -1)
  seconds=0 level=-91
  if [[ -n $file ]]; then
    read -r seconds _ <<<"$(mp4_info "$file")"
    level=$(ffmpeg -hide_banner -nostats -i "$file" -af volumedetect -f null - 2>&1 |
      sed -n 's/.*mean_volume: \(-\{0,1\}[0-9.]*\) dB.*/\1/p')
  fi
  echo "audio $track: ${file:-missing} seconds=${seconds:-0} mean_volume=${level:--91}" >>"$out/actions.log"
  result "audio_${track//-/_}" "$(awk -v s="${seconds:-0}" -v want="${audio_video_seconds:-0}" -v v="${level:--91}" \
    'BEGIN { d = s - want; if (d < 0) d = -d; print (want >= 3 && d <= 0.5 && v > -40 ? "yes" : "no") }')"
done

# With no title to match, the picker's first window must be the other app's:
# Cap's own windows are not offered.
launch picker CAP_GPUI_AUTO_OVERLAY=window
wait_log "$out/picker/cap.log" "auto window target" 30
picked=$(sed 's/\x1b\[[0-9;]*m//g' "$out/picker/cap.log" | grep -a "auto window target" | head -1)
echo "picker: ${picked:-no window picked}" >>"$out/actions.log"
result picker_offers_other_app "$([[ $picked == *'title=Window to record'* ]] && echo yes || echo no)"
finish picker

launch screenshot CAP_GPUI_AUTO_RECORD=screenshot
shot=""
for _ in $(seq 80); do
  shot=$(find "$out/screenshot" -path "*.cap/original.png" 2>/dev/null | head -1)
  [[ -n $shot ]] && break
  sleep 0.25
done
sleep 1
size=$( [[ -n $shot ]] && png_size "$shot")
echo "screenshot: ${shot:-none} ${size:-}" >>"$out/actions.log"
result screenshot_png "$([[ $size == "1920 1080" ]] && echo yes || echo no)"
finish screenshot

cat "$out/result.txt"
failed=0
for key in display_finished area_finished window_finished audio_finished display_video area_video window_video \
  audio_video audio_audio_input audio_system_audio picker_offers_other_app screenshot_png; do
  grep -q "^$key=" "$out/result.txt" || { echo "x11-capture: no $key result" >&2; failed=1; }
done
while IFS== read -r key value; do
  case $key in
    *_panics | *_backup_left) [[ $value == 0 ]] || failed=1 ;;
    *) [[ $value == yes ]] || failed=1 ;;
  esac
done <"$out/result.txt"
exit $failed
