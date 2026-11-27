#!/usr/bin/env python3
"""cl2count.py <os> <tree file>: buttons in one accessibility tree dump (atspi.py / cdax / uia.ps1):
total, named, unnamed, pressable (where the dump shows it), toggles."""
import sys

os_name, path = sys.argv[1], sys.argv[2]
total = named = unnamed = pressable = toggles = disabled = 0
try:
    lines = open(path, encoding="utf-8-sig", errors="replace").read().splitlines()
except OSError:
    print("no tree")
    sys.exit(0)
for line in lines:
    parts = [p.strip() for p in line.strip().split(" | ")]
    if len(parts) < 3:
        continue
    role = parts[0]
    if os_name == "linux":
        if "button" not in role:
            continue
        name = parts[1]
        press = "F" in parts[3] if len(parts) > 3 else False
        toggle = role == "toggle button"
    elif os_name == "mac":
        if not (role.startswith("AXButton") or role.startswith("AXCheckBox")):
            continue
        name = parts[1] or parts[2]
        press = len(parts) > 4 and "F" in parts[4]
        toggle = role.startswith("AXCheckBox")
        # the window's own close/zoom/minimize buttons are not Cap's
        if role.split("/")[1:2] and role.split("/")[1] in ("AXCloseButton", "AXZoomButton", "AXMinimizeButton", "AXFullScreenButton"):
            continue
    else:
        if role not in ("Button", "CheckBox"):
            continue
        name = parts[1]
        press = True
        toggle = role == "CheckBox"
    total += 1
    if name:
        named += 1
    else:
        unnamed += 1
    pressable += press
    toggles += toggle
    flags = parts[4] if os_name == "mac" and len(parts) > 4 else (parts[3] if len(parts) > 3 else "")
    disabled += "D" in flags
print(f"buttons={total} named={named} unnamed={unnamed} pressable={pressable} toggles={toggles} disabled={disabled}")
