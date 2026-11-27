#!/usr/bin/env python3
"""atspi_press.py <pid> <name regex>: press (AT-SPI DoAction, what Orca does on Enter) the first
showing node of that process whose name matches, and print what was pressed and the action names."""
import os
import re
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

pid, pattern = int(sys.argv[1]), re.compile(sys.argv[2])
desktop = Atspi.get_desktop(0)


FRAME = os.environ.get("CD_FRAME")
WITHIN = os.environ.get("CL_WITHIN")


def walk(node, depth=0, inside=False):
    if depth > 60 or node is None:
        return None
    try:
        name = node.get_name() or ""
        if FRAME and node.get_role_name() == "frame" and name != FRAME:
            return None
        inside = inside or not WITHIN or name == WITHIN
        if inside and pattern.search(name) and node.get_action_iface() is not None:
            return node
        for i in range(node.get_child_count()):
            found = walk(node.get_child_at_index(i), depth + 1, inside)
            if found:
                return found
    except Exception:
        return None
    return None


for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    try:
        if app.get_process_id() != pid:
            continue
    except Exception:
        continue
    node = walk(app)
    if node is None:
        print("no pressable node matches", sys.argv[2])
        sys.exit(1)
    action = node.get_action_iface()
    names = [action.get_action_name(k) for k in range(action.get_n_actions())]
    print(f"pressing {node.get_role_name()} {node.get_name()!r} actions={names}")
    ok = action.do_action(0)
    print("do_action returned", ok)
    sys.exit(0 if ok else 2)
print("no app with pid", pid)
sys.exit(1)
