#!/usr/bin/env bash
# Runs a command inside a private X session: Xvfb with a window manager, a
# session bus and a PulseAudio null sink for the start cue, as the Linux jobs
# in instant-reliability.yml set up. A second null sink's monitor is the
# microphone (as in scripts/linux-desktop-harness/x11-capture.sh), so a
# scenario can speak into the microphone without it also being system audio.
set -uo pipefail
if [[ -z ${RC_SESSION_BUS:-} ]]; then
  exec env RC_SESSION_BUS=1 dbus-run-session -- bash "$0" "$@"
fi
unset WAYLAND_DISPLAY
export DISPLAY=:77 XDG_SESSION_TYPE=x11
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -noreset >/dev/null 2>&1 &
xvfb=$!
sleep 1
openbox >/dev/null 2>&1 &
wm=$!
pulse_dir=$(mktemp -d)
pulseaudio -n --daemonize=yes --exit-idle-time=-1 \
  -L "module-native-protocol-unix socket=$pulse_dir/native auth-anonymous=1" \
  -L "module-null-sink sink_name=cap_output" \
  -L "module-null-sink sink_name=cap_micsink" \
  -L "module-remap-source master=cap_micsink.monitor source_name=cap_mic" \
  -L "module-always-sink"
export PULSE_SERVER="unix:$pulse_dir/native"
for _ in $(seq 40); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
pactl set-default-sink cap_output
pactl set-default-source cap_mic
"$@"
status=$?
kill "$wm" "$xvfb" 2>/dev/null
exit $status
