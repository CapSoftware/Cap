#!/usr/bin/env bash
# The editor's "Existing recording" import, chosen the way a person chooses
# it: record a Studio clip, open it in the editor, press Existing recording
# (CAP_GPUI_AUTO_IMPORT_EXISTING), type another recording's folder into the
# desktop portal's chooser and press its accept button. GNOME only (needs
# GNOME_UNSAFE=1). Prints key=value results to $HARNESS_OUT/result.txt.
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
recordings=$out/profile/recordings
target=$(find "$recordings" -mindepth 1 -maxdepth 1 -type d -name '*.cap' | head -1)
source_recording=$recordings/source.cap
cp -r "$target" "$source_recording"
plain=$recordings/plain-folder
mkdir -p "$plain" && echo "not a recording" >"$plain/note.txt"
echo "target: $target" >>"$out/actions.log"
segments() {
  python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("segments", [])))' "$1/recording-meta.json" 2>/dev/null || echo 0
}
result target_segments_before "$(segments "$target")"

shell_eval() {
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>/dev/null
}
chooser_open() {
  shell_eval "global.display.list_all_windows().some(w => /xdg-desktop-portal-gnome|org.gnome.Nautilus/i.test(w.get_wm_class() || ''))" | grep -q "'true'"
}
wait_log() {
  for _ in $(seq $(($3 * 4))); do
    sed 's/\x1b\[[0-9;]*m//g' "$out/$1.log" 2>/dev/null | grep -aq -- "$2" && return 0
    sleep 0.25
  done
  return 1
}

# pick <name> <folder to type>: one launch of the editor, one trip through the chooser.
pick() {
  local name=$1 folder=$2
  bash "$here/launch-cap.sh" "$name" CAP_GPUI_AUTO_EDITOR="$target" CAP_GPUI_AUTO_IMPORT_EXISTING=1 >/dev/null
  if ! wait_log "$name" "editor project validated" 60; then
    result "${name}_editor_opened" no
    return
  fi
  result "${name}_editor_opened" yes
  shell_eval 'Main.overview.hide()' >/dev/null
  local chooser=no
  for _ in $(seq 120); do
    if chooser_open; then chooser=yes; break; fi
    sleep 0.5
  done
  result "${name}_chooser_opened" "$chooser"
  [[ $chooser == yes ]] || return
  sleep 1
  shell_eval "global.display.list_all_windows().map(w => (w.get_title() || '') + ' [' + (w.get_wm_class() || '') + ']').join(' | ')" >>"$out/actions.log"
  shell_eval "global.display.list_all_windows().filter(w => /xdg-desktop-portal-gnome|org.gnome.Nautilus/i.test(w.get_wm_class() || '')).forEach(w => w.activate(global.display.get_current_time_roundtrip()))" >/dev/null
  sleep 1
  bash "$here/shot.sh" "$out/$name-1-opened.png" >/dev/null 2>&1
  python3 "$here/atspi-dump.py" "Nautilus|Files|nautilus|portal" >"$out/$name-1-opened.atspi.txt" 2>&1
  # Ctrl+L opens the location field; typing alone starts a search.
  python3 "$here/mutter-keys.py" Control_L+l >>"$out/actions.log" 2>&1
  sleep 0.5
  python3 "$here/mutter-keys.py" --type "$folder" >>"$out/actions.log" 2>&1
  sleep 1
  bash "$here/shot.sh" "$out/$name-2-typed.png" >/dev/null 2>&1
  python3 "$here/mutter-keys.py" Return >>"$out/actions.log" 2>&1
  sleep 2
  bash "$here/shot.sh" "$out/$name-3-entered.png" >/dev/null 2>&1
  python3 "$here/atspi-dump.py" "Nautilus|Files|nautilus|portal" >"$out/$name-3-entered.atspi.txt" 2>&1
  python3 "$here/atspi-press.py" "Nautilus|Files|nautilus" "^(Select|Open)$" 10 >>"$out/actions.log" 2>&1
  sleep 3
  bash "$here/shot.sh" "$out/$name-4-accepted.png" >/dev/null 2>&1
  result "${name}_chooser_still_open" "$(chooser_open && echo yes || echo no)"
}
finish() {
  local name=$1
  result "${name}_panics" "$(grep -ac 'panicked at' "$out/$name.log" 2>/dev/null || true)"
  result "${name}_cap_alive" "$(kill -0 "$(cat "$XDG_RUNTIME_DIR/$name.pid" 2>/dev/null)" 2>/dev/null && echo yes || echo no)"
  kill "$(cat "$XDG_RUNTIME_DIR/$name.pid" 2>/dev/null)" 2>/dev/null
  sleep 3
  pkill -f xdg-desktop-portal-gnome 2>/dev/null
  sleep 2
}

pick import "$source_recording"
result imported "$(wait_log import "clips imported" 40 && echo yes || echo no)"
sed 's/\x1b\[[0-9;]*m//g' "$out/import.log" | grep -aE "existing recording picked|picker returned nothing|failed to import clip|clips imported" >>"$out/actions.log"
result picked_recording_folder "$(sed 's/\x1b\[[0-9;]*m//g' "$out/import.log" | grep -a "existing recording picked" | grep -aq "source.cap" && echo yes || echo no)"
result target_segments_after "$(segments "$target")"
finish import

if [[ ${REJECT:-1} == 1 ]]; then
  before=$(sha256sum "$target/recording-meta.json" | cut -d' ' -f1)
  result zenity_installed "$(command -v zenity >/dev/null 2>&1 && echo yes || echo no)"
  pick reject "$plain"
  result rejected "$(wait_log reject "failed to import clip: Select a Cap project folder" 40 && echo yes || echo no)"
  error_shown=no
  for _ in $(seq 40); do
    if shell_eval "global.display.list_all_windows().some(w => (w.get_title() || '') == 'Import Error')" | grep -q "'true'"; then
      error_shown=yes
      break
    fi
    sleep 0.5
  done
  result reject_error_dialog_shown "$error_shown"
  shell_eval "global.display.list_all_windows().map(w => (w.get_title() || '') + ' [' + (w.get_wm_class() || '') + ']').join(' | ')" >>"$out/actions.log"
  sleep 1
  bash "$here/shot.sh" "$out/reject-5-error.png" >/dev/null 2>&1
  if [[ $error_shown == yes ]]; then
    shell_eval "global.display.list_all_windows().filter(w => (w.get_title() || '') == 'Import Error').forEach(w => w.activate(global.display.get_current_time_roundtrip()))" >/dev/null
    sleep 1
    python3 "$here/mutter-keys.py" Return >>"$out/actions.log" 2>&1
    sleep 2
    result reject_error_dialog_dismissed "$(shell_eval "global.display.list_all_windows().some(w => (w.get_title() || '') == 'Import Error')" | grep -q "'true'" && echo no || echo yes)"
    bash "$here/shot.sh" "$out/reject-6-dismissed.png" >/dev/null 2>&1
  fi
  result reject_target_unchanged "$([[ $(sha256sum "$target/recording-meta.json" | cut -d' ' -f1) == "$before" ]] && echo yes || echo no)"
  finish reject
fi
cat "$out/result.txt"
