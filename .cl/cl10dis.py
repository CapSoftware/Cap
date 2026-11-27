#!/usr/bin/env python3
"""cl10dis.py <os> <tree file> [buttons]: names of the disabled nodes in a tree dump (flags column has D).
With "buttons", only button-like roles. One name per line."""
import sys

os_name, path = sys.argv[1], sys.argv[2]
only_buttons = len(sys.argv) > 3
for line in open(path, encoding="utf-8-sig", errors="replace").read().splitlines():
    parts = [p.strip() for p in line.strip().split(" | ")]
    if len(parts) < 4:
        continue
    role = parts[0]
    if os_name == "mac":
        name = parts[1] or parts[2]
        flags = parts[4] if len(parts) > 4 else ""
    else:
        name = parts[1]
        flags = parts[3]
    if "D" not in flags:
        continue
    if only_buttons and not any(k in role.lower() for k in ("button", "checkbox", "tab")):
        continue
    print(f"{role} | {name}")
