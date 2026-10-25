#!/usr/bin/env bash
# Runs as the test user inside the systemd GNOME container: starts a headless
# GNOME Shell (with the AppIndicator extension, as Ubuntu ships it) in the
# user's systemd session and exports the session environment to the user bus.
set -euo pipefail
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
mkdir -p "$out"

systemctl --user set-environment XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=ubuntu:GNOME \
  XDG_SESSION_DESKTOP=ubuntu GNOME_SHELL_SESSION_MODE=ubuntu LIBGL_ALWAYS_SOFTWARE=1
# A logged-in GNOME session has graphical-session.target active, and the GNOME
# portal backend will not start without it. It refuses a manual start, so bind
# a harness target to it the way gnome-session's own targets do.
mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/cap-harness-session.target" <<'UNIT'
[Unit]
Description=Cap harness graphical session
BindsTo=graphical-session.target
Before=graphical-session.target
UNIT
systemctl --user daemon-reload
systemctl --user start cap-harness-session.target
gsettings set org.gnome.shell enabled-extensions "['ubuntu-appindicators@ubuntu.com']"
# The virtual pointer starts at the top-left corner; the hot corner would open
# the overview under every injected click.
gsettings set org.gnome.desktop.interface enable-hot-corners false
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.interface toolkit-accessibility true

systemctl --user reset-failed gnome-headless.service >/dev/null 2>&1 || true
systemd-run --user --unit=gnome-headless --collect \
  -p StandardOutput=file:"$out/compositor.log" -p StandardError=inherit \
  gnome-shell --headless --wayland --no-x11 --virtual-monitor 1920x1080 ${GNOME_UNSAFE:+--unsafe-mode}

for _ in $(seq 600); do
  [[ -S "$XDG_RUNTIME_DIR/wayland-0" ]] && break
  sleep 0.1
done
[[ -S "$XDG_RUNTIME_DIR/wayland-0" ]] || { echo "gnome-up: no Wayland socket" >&2; exit 1; }
for _ in $(seq 300); do
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion >/dev/null 2>&1 && break
  sleep 0.1
done
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=ubuntu:GNOME XDG_SESSION_DESKTOP=ubuntu GSK_RENDERER=cairo LIBGL_ALWAYS_SOFTWARE=1
systemctl --user set-environment WAYLAND_DISPLAY=wayland-0
dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP GSK_RENDERER LIBGL_ALWAYS_SOFTWARE
echo "gnome-up: $(gnome-shell --version) on wayland-0"
