#!/usr/bin/env bash
# A screenshot of the display, taken the way the screenshot mode takes one
# (CAP_GPUI_AUTO_RECORD=screenshot), allowing it when the desktop portal asks.
# Checks a PNG of the display's size was saved. Prints key=value results to
# $HARNESS_OUT/result.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE|HYPRLAND_INSTANCE_SIGNATURE|NIRI_SOCKET)=" | sed 's/^/export /')"
: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }

pid=$(bash "$here/launch-cap.sh" cap CAP_GPUI_AUTO_RECORD=screenshot CAP_GPUI_AUTO_OVERLAY=display)
shot=""
for _ in $(seq 120); do
  shot=$(find "$out/profile" -path "*screenshots/*.cap/original.png" 2>/dev/null | head -1)
  [[ -n $shot ]] && break
  # The portal's one-time question, "Allow Cap to Take Screenshots?": GNOME
  # Shell draws it, elsewhere the GTK portal does.
  python3 "$here/atspi-press.py" "gnome-shell|xdg-desktop-portal-gtk|xdg-desktop-portal-gnome" "^Allow$" 1 \
    >>"$out/actions.log" 2>&1
  sleep 0.5
done
sleep 1
size=""
[[ -n $shot ]] && size=$(python3 -c 'import struct, sys
data = open(sys.argv[1], "rb").read(24)
if data[:8] == b"\x89PNG\r\n\x1a\n":
    print(*struct.unpack(">II", data[16:24]))' "$shot")
echo "screenshot: ${shot:-none} ${size:-}" >>"$out/actions.log"
result screenshot_taken "$([[ -n $shot ]] && echo yes || echo no)"
result screenshot_size "${size// /x}"
result capture_failed "$(grep -ac 'screenshot capture failed' "$out/cap.log")"
result cap_alive "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
result panics "$(grep -ac 'panicked at' "$out/cap.log")"
cat "$out/result.txt"
