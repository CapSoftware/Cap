#!/usr/bin/env bash
# Usage: x11-camera.sh <cap-gpui> <ffmpeg lib dir> <out-dir>
# CAMERA_FORMAT picks what the virtual camera sends: yuyv422 (default), nv12
# or mjpeg, the three formats Cap's Linux camera path converts.
set -uo pipefail
for tool in Xvfb xdotool ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "install xvfb, xdotool and ffmpeg" >&2; exit 2; }
done
if [[ -z ${X11_CAMERA_BUS:-} ]]; then
  exec env X11_CAMERA_BUS=1 dbus-run-session -- bash "$0" "$@"
fi
bin=$1 libs=$2 out=$3
mkdir -p "$out" && : >"$out/result.txt" || { echo "x11-camera: cannot write to $out" >&2; exit 2; }
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }

device=/dev/video42
format=${CAMERA_FORMAT:-yuyv422}
case $format in
  yuyv422|nv12) encode=(-pix_fmt "$format") ;;
  mjpeg) encode=(-pix_fmt yuvj422p -c:v mjpeg -q:v 4) ;;
  *) echo "x11-camera: unknown CAMERA_FORMAT $format" >&2; exit 2 ;;
esac
# A fresh device per run, so the format of an earlier run cannot stick. The
# previous run waited for its feeder and Cap to exit, but the module can stay
# busy for a moment after; never reuse a device that would not unload.
for _ in $(seq 20); do
  lsmod | grep -q '^v4l2loopback ' || break
  sudo modprobe -r v4l2loopback 2>/dev/null || sleep 0.5
done
if lsmod | grep -q '^v4l2loopback '; then
  echo "x11-camera: v4l2loopback is still in use and cannot be reloaded" >&2
  exit 2
fi
sudo modprobe v4l2loopback video_nr=42 card_label="Cap Test Camera" exclusive_caps=1 || exit 2
# udev applies its own mode to the new node after modprobe returns; let it
# finish first so it cannot reset the chmod below.
sudo udevadm settle --timeout=10
sudo chmod 666 "$device"
ffmpeg -hide_banner -loglevel error -nostdin -re -f lavfi -i testsrc2=size=1280x720:rate=30 "${encode[@]}" \
  -f v4l2 "$device" >"$out/feeder.log" 2>&1 &
feeder=$!
unset WAYLAND_DISPLAY
export DISPLAY=:73 XDG_SESSION_TYPE=x11
Xvfb "$DISPLAY" -screen 0 1920x1080x24 >/dev/null 2>&1 &
xvfb=$!
pid=""
# Wait for every child, so the next run finds the camera device closed.
cleanup() {
  kill $feeder $xvfb $pid 2>/dev/null
  wait $feeder $xvfb $pid 2>/dev/null
}
trap cleanup EXIT
sleep 2
echo "feeder ($format): $(kill -0 $feeder 2>/dev/null && echo running || echo exited) $(head -c 300 "$out/feeder.log")" >>"$out/actions.log"

profile=$out/profile
log=$out/cap.log
mkdir -p "$profile/recordings" "$profile/logs"
printf '%s' '{"general_settings":{"hasCompletedStartup":true,"hasCompletedOnboarding":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"recording_start_safety":{"confirmBeforeRecordingWithoutMicrophone":false}}' >"$profile/store"
env LD_LIBRARY_PATH="$libs" CAP_GPUI_APP_DATA_DIR="$profile" CAP_GPUI_RECORDINGS_DIR="$profile/recordings" \
  CAP_GPUI_LOG_DIR="$profile/logs" CAP_GPUI_NO_TRAY=1 CAP_GPUI_AUTO_NO_MIC=1 RUST_LOG=info \
  CAP_GPUI_AUTO_CAMERA=1 CAP_GPUI_AUTO_RECORD=studio:60 "$bin" >"$log" 2>&1 &
pid=$!

wait_log() {
  for _ in $(seq $(($2 * 4))); do
    grep -aq -- "$1" "$log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

camera=no started=no finished=no
wait_log "auto-selecting camera" 30 && camera=yes
wait_log "auto-record start requested" 30
sleep 2
xdotool key ctrl+shift+F9
wait_log "recording started" 30 && started=yes
if [[ $started == yes ]]; then
  sleep 5
  xdotool key ctrl+shift+F9
  # Well before the 60 s automatic stop, so a Stop shortcut that does not
  # work fails here.
  wait_log "recording finished" 15 && finished=yes
fi
sleep 2
result camera_selected "$camera"
result started "$started"
result finished "$finished"

probe() {
  ffprobe -v error -select_streams v:0 -count_packets \
    -show_entries stream=width,height,nb_read_packets:format=duration -of csv=p=0 "$1" 2>/dev/null |
    tr ',\n' '  '
}
display=$(find "$profile/recordings" -path "*segment-0/display.mp4" | head -1)
camera_video=$(find "$profile/recordings" -path "*segment-0/camera.mp4" | head -1)
read -r _ _ display_frames display_seconds <<<"$( [[ -n $display ]] && probe "$display")"
read -r width height frames seconds <<<"$( [[ -n $camera_video ]] && probe "$camera_video")"
echo "display: ${display:-none} frames=${display_frames:-} seconds=${display_seconds:-}" >>"$out/actions.log"
echo "camera: ${camera_video:-none} ${width:-}x${height:-} frames=${frames:-} seconds=${seconds:-}" >>"$out/actions.log"
result camera_size "$([[ $width == 1280 && $height == 720 ]] && echo yes || echo no)"
result camera_matches_display "$(awk -v c="${seconds:-0}" -v d="${display_seconds:-0}" \
  'BEGIN { x = c - d; if (x < 0) x = -x; print (c >= 4 && c <= 8 && x <= 0.5 ? "yes" : "no") }')"
result cap_alive "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
result panics "$(grep -ac 'panicked at' "$log")"
kill "$pid" 2>/dev/null

cat "$out/result.txt" "$out/actions.log"
failed=0
for key in camera_selected started finished camera_size camera_matches_display cap_alive panics; do
  grep -q "^$key=" "$out/result.txt" || { echo "x11-camera: no $key result" >&2; failed=1; }
done
while IFS== read -r key value; do
  case $key in
    panics) [[ $value == 0 ]] || failed=1 ;;
    *) [[ $value == yes ]] || failed=1 ;;
  esac
done <"$out/result.txt"
exit $failed
