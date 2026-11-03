#!/usr/bin/env bash
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}

bash "$here/scenario-start-stop.sh" >/dev/null
recorded=$(sed -n 's/^attempt1_finished=//p' "$out/result.txt")
mv "$out/result.txt" "$out/recording-result.txt"
: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
result recorded "${recorded:-no}"
[[ $recorded == yes ]] || exit 0

eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE|HYPRLAND_INSTANCE_SIGNATURE|NIRI_SOCKET)=" | sed 's/^/export /')"

mp4_seconds() {
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


for kind, body, end in boxes(0, len(data)):
    if kind != b"moov":
        continue
    for inner, inner_body, _ in boxes(body, end):
        if inner == b"mvhd":
            version = data[inner_body]
            if version == 1:
                scale, duration = struct.unpack(">IQ", data[inner_body + 20 : inner_body + 32])
            else:
                scale, duration = struct.unpack(">II", data[inner_body + 12 : inner_body + 20])
            if scale:
                print(f"{duration / scale:.2f}")
PY
}

# The encoder merges identical frames into longer ones, so a GIF's length is
# the sum of its frame delays.
gif_frames_and_seconds() {
  python3 - "$1" <<'PY'
import sys

data = open(sys.argv[1], "rb").read()
if data[:6] in (b"GIF87a", b"GIF89a"):
    frames, centiseconds, at = 0, 0, data.find(b"\x21\xf9\x04")
    while at != -1 and at + 6 <= len(data):
        frames += 1
        centiseconds += data[at + 4] | data[at + 5] << 8
        at = data.find(b"\x21\xf9\x04", at + 8)
    print(frames, f"{centiseconds / 100:.2f}")
PY
}

# An export holds the whole clip: its length is the recording's, give or take
# half a second.
matches_source() {
  awk -v s="$1" -v want="${source_seconds:-0}" 'BEGIN { d = s - want; if (d < 0) d = -d; print (want >= 1 && d <= 0.5 ? "yes" : "no") }'
}

export_once() {
  local kind=$1 file=$out/export.$1 name=cap-$1
  bash "$here/launch-cap.sh" "$name" CAP_GPUI_AUTO_EDITOR=1 CAP_GPUI_AUTO_EXPORT="$file" >/dev/null
  local done=""
  for _ in $(seq 720); do
    done=$(sed 's/\x1b\[[0-9;]*m//g' "$out/$name.log" 2>/dev/null |
      grep -aoE "editor export completed|editor export failed.*|export waits for the user to confirm.*|panicked at.*" | head -1)
    [[ -n $done ]] && break
    sleep 0.25
  done
  echo "$kind: ${done:-no export line}" >>"$out/actions.log"
  result "${kind}_exported" "$([[ $done == "editor export completed" ]] && echo yes || echo no)"
  if [[ $kind == mp4 ]]; then
    local seconds
    seconds=$(mp4_seconds "$file" 2>/dev/null)
    echo "mp4 seconds: ${seconds:-none}, bytes: $(stat -c %s "$file" 2>/dev/null)" >>"$out/actions.log"
    result mp4_has_video "$(matches_source "${seconds:-0}")"
  else
    local frames seconds
    read -r frames seconds < <(gif_frames_and_seconds "$file" 2>/dev/null)
    echo "gif frames: ${frames:-none}, seconds: ${seconds:-none}, bytes: $(stat -c %s "$file" 2>/dev/null)" >>"$out/actions.log"
    result gif_has_video "$(matches_source "${seconds:-0}")"
  fi
  result "${kind}_cap_alive" "$(kill -0 "$(cat "$XDG_RUNTIME_DIR/$name.pid" 2>/dev/null)" 2>/dev/null && echo yes || echo no)"
  kill "$(cat "$XDG_RUNTIME_DIR/$name.pid" 2>/dev/null)" 2>/dev/null
  sleep 2
}

source_seconds=$(mp4_seconds "$(find "$out/profile/recordings" -path "*segment-0/display.mp4" | head -1)" 2>/dev/null)
echo "recording seconds: ${source_seconds:-none}" >>"$out/actions.log"
export_once mp4
export_once gif
cat "$out/result.txt"
