#!/usr/bin/env bash
# xdg-desktop-portal-hyprland picker stand-in: share the first monitor, the
# choice a person makes in hyprland-share-picker with one screen.
monitor=$(hyprctl monitors -j 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["name"])' 2>/dev/null)
echo "[SELECTION]/screen:${monitor:-Virtual-1}"
