#!/usr/bin/env bash
# Screenshot the headless GNOME session (pass GNOME_UNSAFE=1 to run-desktop.sh).
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot false false "${1:-/out/shot.png}"
