#!/usr/bin/env bash
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE|HYPRLAND_INSTANCE_SIGNATURE|NIRI_SOCKET)=" | sed 's/^/export /')"
: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }

# Outside GNOME the question comes from the GTK portal, which aborts in this
# container (its image loader sandbox cannot start), so the permission is
# granted up front there; GNOME Shell asks for real.
if [[ $XDG_CURRENT_DESKTOP != *GNOME* ]]; then
  for app in Cap so.cap.Cap ""; do
    gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore \
      --object-path /org/freedesktop/impl/portal/PermissionStore \
      --method org.freedesktop.impl.portal.PermissionStore.SetPermission \
      screenshot true screenshot "$app" "['yes']" >/dev/null 2>&1
  done
fi

# PRELAUNCH=1 runs Cap once first, as on a system Cap has run on: a shell
# launch writes so.cap.Cap.desktop, which GNOME reads a few seconds later.
if [[ ${PRELAUNCH:-} == 1 ]]; then
  first=$(bash "$here/launch-cap.sh" first)
  sleep 8
  kill "$first" 2>/dev/null
  sleep 3
fi

# LAUNCH=dock starts Cap in the unit GNOME's app grid gives it, as
# scenario-start-stop.sh does; LAUNCH=terminal from a shell.
if [[ ${LAUNCH:-dock} == dock ]]; then
  export CAP_LAUNCH_PREFIX="systemd-run --user --scope --quiet --unit=app-gnome-Cap-$$.scope"
fi
pid=$(bash "$here/launch-cap.sh" cap CAP_GPUI_AUTO_RECORD=screenshot CAP_GPUI_AUTO_OVERLAY=display)

# A person starts a screenshot by clicking Cap, so Cap has focus when the
# portal asks; the automated start does not click.
focus_cap() {
  if [[ $XDG_CURRENT_DESKTOP == *GNOME* ]]; then
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
      "global.display.list_all_windows().filter(w => /^(Cap|so\.cap\.Cap)$/.test(w.get_wm_class() || '') && w.showing_on_its_workspace()).forEach(w => w.activate(global.display.get_current_time_roundtrip()))" \
      >/dev/null 2>&1
  elif [[ -n ${HYPRLAND_INSTANCE_SIGNATURE:-} ]]; then
    hyprctl dispatch focuswindow class:Cap >/dev/null 2>&1
  fi
}
for _ in $(seq 60); do
  grep -aq "taking a screenshot" "$out/cap.log" 2>/dev/null && break
  focus_cap
  sleep 0.1
done
if [[ $XDG_CURRENT_DESKTOP == *GNOME* ]]; then
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
    "(imports.gi.Shell.WindowTracker.get_default().focus_app || {get_id: () => 'none'}).get_id()" \
    2>&1 | sed 's/^/focused app: /' >>"$out/actions.log"
fi
shot=""
for _ in $(seq 120); do
  shot=$(find "$out/profile" -path "*screenshots/*.cap/original.png" 2>/dev/null | head -1)
  [[ -n $shot ]] && break
  # The portal's one-time question, "Allow Cap to Take Screenshots?": GNOME
  # Shell draws it (no accessibility tree here, so its button is clicked from
  # the Shell), elsewhere the GTK portal does.
  if [[ $XDG_CURRENT_DESKTOP == *GNOME* ]]; then
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
      "(() => { const find = a => { if (a instanceof imports.gi.St.Button && a.label === 'Allow') return a; for (const c of a.get_children()) { const f = find(c); if (f) return f; } return null; }; const b = find(global.stage); if (!b) return 'none'; b.emit('clicked', 1); return 'clicked Allow'; })()" \
      2>&1 | grep -o "clicked Allow" >>"$out/actions.log"
  else
    python3 "$here/atspi-press.py" "xdg-desktop-portal-gtk|xdg-desktop-portal-gnome" "^Allow$" 1 >>"$out/actions.log" 2>&1
  fi
  sleep 0.5
done
sleep 1
size=""
[[ -n $shot ]] && size=$(python3 -c 'import struct, sys
data = open(sys.argv[1], "rb").read(24)
if data[:8] == b"\x89PNG\r\n\x1a\n":
    print(*struct.unpack(">II", data[16:24]))' "$shot")
echo "screenshot: ${shot:-none} ${size:-}" >>"$out/actions.log"
result screenshot_taken "$([[ -n $size ]] && echo yes || echo no)"
result screenshot_size "$([[ ${size// /x} == "${SCREEN:-1920x1080}" ]] && echo yes || echo "${size// /x}")"
result capture_failed "$(grep -ac 'screenshot capture failed' "$out/cap.log")"
if [[ -z $shot ]]; then
  find "$HOME" /tmp -newer "$out/profile/store" -iname "Screenshot*.png" -printf "portal file: %s bytes %p\n" 2>/dev/null >>"$out/actions.log"
  journalctl --user --no-pager -n 300 2>/dev/null | grep -iE "access dialog|screenshot|portal-(gtk|hyprland|gnome)\[" | tail -8 >>"$out/actions.log"
fi
result cap_alive "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
result panics "$(grep -ac 'panicked at' "$out/cap.log")"
cat "$out/result.txt"
