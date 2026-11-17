#!/usr/bin/env bash
# The editor's background image, chosen the way a person chooses it: record a
# Studio clip, open it in the editor, press the Image tab's "choose an image"
# (CAP_GPUI_AUTO_PICK_BACKGROUND), type a picture's path into the desktop
# portal's file chooser and press Return. GNOME only (needs GNOME_UNSAFE=1 for
# the recording's dialogs). Prints key=value results to $HARNESS_OUT/result.txt.
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

eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE)=" | sed 's/^/export /')"
picture=/tmp/cap-background.png
python3 - "$picture" <<'PY'
import sys

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf

image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 320, 180)
image.fill(0x3366CCFF)
image.savev(sys.argv[1], "png", [], [])
PY

wait_log() {
  for _ in $(seq $(($2 * 4))); do
    grep -aq -- "$1" "$out/cap2.log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

bash "$here/launch-cap.sh" cap2 CAP_GPUI_AUTO_EDITOR=1 CAP_GPUI_AUTO_PICK_BACKGROUND=1 >/dev/null
if ! wait_log "editor project validated" 60; then
  result editor_opened no
  exit 0
fi
result editor_opened yes
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
  --method org.gnome.Shell.Eval 'Main.overview.hide()' >/dev/null 2>&1

chooser=no
for _ in $(seq 60); do
  if gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "global.display.list_all_windows().some(w => /xdg-desktop-portal-gnome|org.gnome.Nautilus/i.test(w.get_wm_class() || ''))" 2>/dev/null |
    grep -q "'true'"; then
    chooser=yes
    break
  fi
  sleep 0.5
done
result chooser_opened "$chooser"
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
  "global.display.list_all_windows().map(w => (w.get_title() || '') + ' [' + (w.get_wm_class() || '') + ']').join(' | ')" >>"$out/actions.log" 2>&1
if [[ $chooser == yes ]]; then
  sleep 1
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
    "global.display.list_all_windows().filter(w => /xdg-desktop-portal-gnome|org.gnome.Nautilus/i.test(w.get_wm_class() || '')).forEach(w => w.activate(global.display.get_current_time_roundtrip()))" >/dev/null 2>&1
  sleep 1
  # Ctrl+L opens the location field; typing alone starts a search.
  python3 "$here/mutter-keys.py" Control_L+l >>"$out/actions.log" 2>&1
  sleep 0.5
  python3 "$here/mutter-keys.py" --type "$picture" >>"$out/actions.log" 2>&1
  sleep 1
  bash "$here/shot.sh" "$out/chooser.png" >/dev/null 2>&1
  # Return takes the completion; Select returns the file.
  python3 "$here/mutter-keys.py" Return >>"$out/actions.log" 2>&1
  sleep 1
  python3 "$here/atspi-press.py" "Nautilus|Files|nautilus" "^Select$" 10 >>"$out/actions.log" 2>&1
fi
if wait_log "background image chosen" 20; then
  result background_chosen yes
else
  result background_chosen no
fi
result cap_alive "$(kill -0 "$(cat "$XDG_RUNTIME_DIR/cap2.pid" 2>/dev/null)" 2>/dev/null && echo yes || echo no)"
cat "$out/result.txt"
