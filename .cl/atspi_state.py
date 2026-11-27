#!/usr/bin/env python3
"""atspi_state.py <pid> <name regex>: what Orca reads about the first node of that process (inside
the frame CD_FRAME when set) whose name matches: role | name | selected | description | actions."""
import os
import re
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

pid, pattern = int(sys.argv[1]), re.compile("^" + re.escape(sys.argv[2]) + "$")
FRAME = os.environ.get("CD_FRAME")
desktop = Atspi.get_desktop(0)


def walk(node, depth=0):
    if depth > 60 or node is None:
        return None
    try:
        name = node.get_name() or ""
        if FRAME and node.get_role_name() == "frame" and name != FRAME:
            return None
        if pattern.search(name):
            return node
        for i in range(node.get_child_count()):
            found = walk(node.get_child_at_index(i), depth + 1)
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
        print(f"none | {sys.argv[2]} | - | - | -")
        sys.exit(1)
    states = node.get_state_set()
    action = node.get_action_iface()
    names = [action.get_action_name(k) for k in range(action.get_n_actions())] if action else []
    selected = "selected" if states.contains(Atspi.StateType.SELECTED) else "not-selected"
    if not states.contains(Atspi.StateType.SELECTABLE):
        selected += "(not selectable)"
    try:
        attrs = node.get_attributes() or {}
    except Exception:
        attrs = {}
    pos = f"{attrs.get('posinset', '?')} of {attrs.get('setsize', '?')}"
    print(f"{node.get_role_name()} | {node.get_name()} | {selected} | pos {pos} | {node.get_description() or ''} | {','.join(names)}")
    sys.exit(0)
print("no app with pid", pid)
sys.exit(1)
