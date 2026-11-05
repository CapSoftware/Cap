#!/usr/bin/env bash
# Cap is running with another window focused (its settings); GNOME Shell then
# launches Cap again the way the app grid launches any app, with an
# activation token. The relaunch must hand over to the running Cap and bring
# its main window to the front. Needs GNOME_UNSAFE=1 (Shell.Eval).
# Prints key=value results to $HARNESS_OUT/result.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP)=" | sed 's/^/export /')"

: >"$out/result.txt"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
shell() {
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "$1" 2>/dev/null
}
focused() { shell "global.display.focus_window ? global.display.focus_window.get_title() : ''" | sed -n "s/^(true, '\"\\(.*\\)\"')$/\\1/p"; }
wait_log() {
  for _ in $(seq $(($3 * 4))); do
    grep -q -- "$2" "$out/$1.log" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# RAISE_WINDOW=main reopens a Cap that finished setup; the default reopens one
# still showing onboarding, which the reopen brings forward instead.
expected="Welcome to Cap"
if [[ ${RAISE_WINDOW:-onboarding} == main ]]; then
  expected=Cap
  mkdir -p "$out/profile"
  cat >"$out/profile/store" <<'JSON'
{
  "general_settings": {
    "hasCompletedStartup": true,
    "hasCompletedOnboarding": true,
    "enableNotifications": false,
    "enableTelemetry": false,
    "recordingCountdown": 0
  }
}
JSON
fi
result window "$expected"

CAP_ARGS='cap-desktop://action?value=%7B%22open_settings%22%3A%7B%22page%22%3Anull%7D%7D' \
  bash "$here/launch-cap.sh" cap >/dev/null
if ! wait_log cap "settings window opened" 30; then
  result first_ready no
  exit 0
fi
shell 'Main.overview.hide()' >/dev/null
sleep 2
shell "global.display.list_all_windows().find(w => w.get_title() === 'Cap Settings').activate(global.display.get_current_time_roundtrip())" >/dev/null
sleep 1
before=$(focused)
result focused_before "${before:-none}"

# The same build and profile the running Cap uses, as an app GNOME launches.
profile="$out/profile"
mkdir -p "$HOME/.local/share/applications"
cat >"$HOME/.local/share/applications/cap-under-test.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Cap under test
StartupNotify=true
Exec=env CAP_GPUI_APP_DATA_DIR=$profile CAP_GPUI_RECORDINGS_DIR=$profile/recordings CAP_GPUI_LOG_DIR=$profile/logs LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-} RUST_LOG=info sh -c 'echo "launch token: \${XDG_ACTIVATION_TOKEN:-none}" >"$out/second.log"; exec "\$0" >>"$out/second.log" 2>&1' ${CAP_BIN:-/usr/bin/Cap}
DESKTOP
shell "imports.gi.Gio.DesktopAppInfo.new_from_filename('$HOME/.local/share/applications/cap-under-test.desktop').launch([], global.create_app_launch_context(global.display.get_current_time_roundtrip(), -1))" >>"$out/actions.log"
wait_log second "Requested the existing Cap GPUI controls" 20 && result reopen_forwarded yes || result reopen_forwarded no
grep -q "forwarding the launcher's activation token" "$out/second.log" && result relaunch_had_token yes || result relaunch_had_token no
sleep 3
after=$(focused)
shell "global.display.list_all_windows().map(w => [w.get_title(), w.get_wm_class(), w.minimized, w.showing_on_its_workspace(), w.is_hidden ? w.is_hidden() : '', w.get_frame_rect().width + 'x' + w.get_frame_rect().height].join(':')).join(' | ')" >>"$out/actions.log"
result focused_after "${after:-none}"
if [[ $before == "Cap Settings" && $after == "$expected" ]]; then
  result main_raised yes
else
  result main_raised no
fi
cat "$out/result.txt"
