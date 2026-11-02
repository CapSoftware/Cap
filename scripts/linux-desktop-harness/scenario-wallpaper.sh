#!/usr/bin/env bash
# The editor's "Use the wallpaper from your desktop" background: record a
# Studio clip, open it in the editor and import the desktop's wallpaper
# (CAP_GPUI_AUTO_DESKTOP_BACKGROUND). GNOME keeps its default wallpaper, a
# JPEG XL file named in GSettings. WALLPAPER=swaybg starts swaybg with a PNG
# first, the way Omarchy draws its wallpaper on Hyprland. Prints key=value
# results to $HARNESS_OUT/result.txt.
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

if [[ ${WALLPAPER:-} == swaybg ]]; then
  expected=/tmp/cap-wallpaper.png
  python3 - "$expected" <<'PY'
import struct
import sys
import zlib

width, height = 640, 360
rows = b"".join(b"\x00" + bytes((0x2E, 0x8B, 0x57)) * width for _ in range(height))


def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


with open(sys.argv[1], "wb") as png:
    png.write(b"\x89PNG\r\n\x1a\n")
    png.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
    png.write(chunk(b"IDAT", zlib.compress(rows)))
    png.write(chunk(b"IEND", b""))
PY
  swaybg -i "$expected" -m fill >"$out/swaybg.log" 2>&1 &
  sleep 1
else
  uri=$(gsettings get org.gnome.desktop.background picture-uri | tr -d "'")
  expected=${uri#file://}
fi
echo "expected wallpaper: $expected" >>"$out/actions.log"
result expected_exists "$([[ -f $expected ]] && echo yes || echo no)"

wait_log() {
  for _ in $(seq $(($2 * 4))); do
    grep -aqE -- "$1" "$out/cap2.log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

bash "$here/launch-cap.sh" cap2 CAP_GPUI_AUTO_EDITOR=1 CAP_GPUI_AUTO_DESKTOP_BACKGROUND=1 >/dev/null
if ! wait_log "editor project validated" 60; then
  result editor_opened no
  exit 0
fi
result editor_opened yes
wait_log "desktop wallpaper imported|couldn't import your desktop wallpaper" 60
log=$(sed 's/\x1b\[[0-9;]*m//g' "$out/cap2.log")
found=$(grep -a "found the desktop wallpaper" <<<"$log" | sed -n 's/.* path=\(.*\)$/\1/p' | tail -1)
result wallpaper_found "$([[ -n $found && $found == "$expected" ]] && echo yes || echo "${found:-no}")"
imported=$(grep -a "desktop wallpaper imported" <<<"$log" | sed -n 's/.* path=\(.*\)$/\1/p' | tail -1)
if [[ -n $imported && $(head -c 3 "$imported" 2>/dev/null | od -An -tx1 | tr -d ' \n') == ffd8ff ]]; then
  result wallpaper_imported yes
  echo "imported $(stat -c %s "$imported") bytes of JPEG: $imported" >>"$out/actions.log"
else
  result wallpaper_imported no
  grep -a "couldn't import your desktop wallpaper" <<<"$log" | tail -1 >>"$out/actions.log"
fi
result cap_alive "$(kill -0 "$(cat "$XDG_RUNTIME_DIR/cap2.pid" 2>/dev/null)" 2>/dev/null && echo yes || echo no)"
cat "$out/result.txt"
