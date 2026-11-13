#!/usr/bin/env bash
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE|HYPRLAND_INSTANCE_SIGNATURE|NIRI_SOCKET)=" | sed 's/^/export /')"
expected_size=${SCREEN:-1920x1080}
if [[ -n ${HYPRLAND_INSTANCE_SIGNATURE:-} ]]; then
  expected_size=$(hyprctl -j monitors | python3 -c 'import json, sys
monitor, = json.load(sys.stdin)
print("{}x{}".format(monitor["width"], monitor["height"]))') || exit 1
fi
# AREA=x,y,width,height takes a screenshot of that area of the display, as
# drawing a selection does, and checks nothing of the selection overlay is left
# in it: the area must match the same area of a screenshot the portal takes of
# the desktop before Cap starts.
target=(CAP_GPUI_AUTO_OVERLAY=display)
if [[ -n ${AREA:-} ]]; then
  IFS=, read -r _ _ area_width area_height <<<"$AREA"
  expected_size=${area_width}x${area_height}
  target=(CAP_GPUI_AUTO_OVERLAY=area CAP_GPUI_AUTO_AREA="$AREA")
  # A profile past onboarding: its window would otherwise be in the area.
  mkdir -p "$out/profile"
  cat >"$out/profile/store" <<'JSON'
{
  "general_settings": {
    "hasCompletedStartup": true,
    "hasCompletedOnboarding": true,
    "enableNotifications": false,
    "enableTelemetry": false
  }
}
JSON
fi
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

# On GNOME only Cap's own request is left for the Shell to ask about. The
# reference below is requested by a harness script, which the portal sees as
# an app without an id and which nobody is there to allow.
if [[ -n ${AREA:-} && $XDG_CURRENT_DESKTOP == *GNOME* ]]; then
  gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore \
    --object-path /org/freedesktop/impl/portal/PermissionStore \
    --method org.freedesktop.impl.portal.PermissionStore.SetPermission \
    screenshot true screenshot "" "['yes']" >/dev/null 2>&1
fi

# The KDE portal saves its screenshots to the Pictures folder and fails without
# one, which a fresh home does not have.
mkdir -p "$HOME/Pictures"

# The desktop keeps painting for a while after it starts (wallpaper, panel), so
# the reference is the first screenshot whose pixel data matches the one
# before it, or the fifth: Hyprland's never match exactly.
if [[ -n ${AREA:-} ]]; then
  previous=""
  for attempt in $(seq 5); do
    python3 "$here/portal-shot.py" "$out/reference.png" 2>>"$out/actions.log" || { sleep 1; continue; }
    current=$(python3 -c 'import hashlib, struct, sys
data, position, digest = open(sys.argv[1], "rb").read(), 8, hashlib.sha256()
while position < len(data):
    length, kind = struct.unpack(">I4s", data[position : position + 8])
    if kind == b"IDAT":
        digest.update(data[position + 8 : position + 8 + length])
    position += 12 + length
print(digest.hexdigest())' "$out/reference.png")
    [[ $current == "$previous" ]] && break
    previous=$current
    sleep 1
  done
  echo "reference: settled after $attempt screenshots" >>"$out/actions.log"
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
pid=$(bash "$here/launch-cap.sh" cap CAP_GPUI_AUTO_RECORD=screenshot "${target[@]}")

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
result screenshot_size "$([[ ${size// /x} == "$expected_size" ]] && echo yes || echo "${size// /x}")"
result capture_failed "$(grep -ac 'screenshot capture failed' "$out/cap.log")"
if [[ -n ${AREA:-} && -n $shot ]]; then
  cp "$shot" "$out/screenshot.png"
  difference=$(python3 "$here/png-diff.py" "$shot" "$out/reference.png" "$AREA" 2>&1)
  echo "overlay check: $difference" >>"$out/actions.log"
  changed=$(sed -n 's/^changed=\([0-9]*\) .*/\1/p' <<<"$difference")
  result overlay_left "$([[ $changed == 0 ]] && echo no || echo "${changed:-unknown}")"
fi
if [[ -z $shot ]]; then
  find "$HOME" /tmp -newer "$out/profile/store" -iname "Screenshot*.png" -printf "portal file: %s bytes %p\n" 2>/dev/null >>"$out/actions.log"
  journalctl --user --no-pager -n 300 2>/dev/null | grep -iE "access dialog|screenshot|portal-(gtk|hyprland|gnome)\[" | tail -8 >>"$out/actions.log"
fi
result cap_alive "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"
result panics "$(grep -ac 'panicked at' "$out/cap.log")"
cat "$out/result.txt"
