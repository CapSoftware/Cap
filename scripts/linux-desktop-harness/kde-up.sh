#!/usr/bin/env bash
# Runs as the test user inside the systemd KDE container: KWin on its virtual
# backend at 1920x1080 with plasmashell (the tray host) and the KDE portal, in
# software. Exports the session to the user bus and systemd manager.
set -euo pipefail
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
mkdir -p "$out" "$HOME/.config/systemd/user"
session=(XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE XDG_SESSION_DESKTOP=KDE KDE_FULL_SESSION=true
  KDE_SESSION_VERSION=6 LIBGL_ALWAYS_SOFTWARE=1 QT_QPA_PLATFORM=wayland QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
  KWIN_COMPOSE=O2)
systemctl --user set-environment "${session[@]}"
# The KDE portal backend, like GNOME's, waits for graphical-session.target.
cat >"$HOME/.config/systemd/user/cap-harness-session.target" <<'UNIT'
[Unit]
Description=Cap harness graphical session
BindsTo=graphical-session.target
Before=graphical-session.target
UNIT
systemctl --user daemon-reload
systemctl --user start cap-harness-session.target

# KWin streams screens only when it composites with OpenGL, which its virtual
# backend does only on a DRM render node (load vgem on a host without a GPU).
ls /dev/dri/renderD* >/dev/null 2>&1 ||
  { echo "kde-up: no DRM render node; run 'modprobe vgem' on the host" >&2; exit 1; }
systemctl --user reset-failed kwin-headless.service >/dev/null 2>&1 || true
# KWin brings its own Qt platform; the session's is for the apps it hosts.
kwin_env=()
for variable in "${session[@]}"; do
  [[ $variable == QT_QPA_PLATFORM=* ]] || kwin_env+=("$variable")
done
systemd-run --user --unit=kwin-headless --collect \
  -p StandardOutput=file:"$out/compositor.log" -p StandardError=inherit \
  env "${kwin_env[@]}" kwin_wayland --virtual --width 1920 --height 1080 --no-lockscreen --socket wayland-0
for _ in $(seq 600); do
  [[ -S "$XDG_RUNTIME_DIR/wayland-0" ]] && break
  sleep 0.1
done
[[ -S "$XDG_RUNTIME_DIR/wayland-0" ]] || { echo "kde-up: no Wayland socket" >&2; exit 1; }
export WAYLAND_DISPLAY=wayland-0 "${session[@]}"
systemctl --user set-environment WAYLAND_DISPLAY=wayland-0
dbus-update-activation-environment --systemd WAYLAND_DISPLAY "${session[@]%%=*}"

systemd-run --user --unit=plasmashell --collect \
  -p StandardOutput=file:"$out/plasmashell.log" -p StandardError=inherit plasmashell
tray=no
for _ in $(seq 300); do
  if gdbus call --session --dest org.kde.StatusNotifierWatcher --object-path /StatusNotifierWatcher \
    --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher \
    IsStatusNotifierHostRegistered 2>/dev/null | grep -q "<true>"; then
    tray=yes
    break
  fi
  sleep 0.1
done
[[ $tray == yes ]] || { echo "kde-up: plasmashell registered no tray host" >&2; exit 1; }
echo "kde-up: $(kwin_wayland --version 2>/dev/null) on wayland-0"
