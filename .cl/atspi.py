#!/usr/bin/env python3
# atspi.py tree|focus <pid>: what Orca can see of one process through AT-SPI.
#   tree   every node: depth role | name | description | flags (F focusable, * focused, s showing)
#   focus  the focused node(s) only, one line each
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

#   where <pid> <regex>   screen centre "x y" of the first showing node whose name matches
mode, pid = sys.argv[1], int(sys.argv[2])
pattern = None
if mode == "where":
    import re

    pattern = re.compile(sys.argv[3])
desktop = Atspi.get_desktop(0)
apps = []
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    try:
        if app is not None and app.get_process_id() == pid:
            apps.append(app)
    except Exception:
        pass

FLAGS = (("F", Atspi.StateType.FOCUSABLE), ("*", Atspi.StateType.FOCUSED), ("s", Atspi.StateType.SHOWING))
out = []
count = {"nodes": 0, "named": 0, "focusable": 0}


def walk(node, depth):
    if depth > 60:
        return
    try:
        role = node.get_role_name()
        name = (node.get_name() or "").replace("\n", " ")[:120]
        desc = (node.get_description() or "").replace("\n", " ")[:80]
        states = node.get_state_set()
        flags = "".join(c for c, s in FLAGS if states.contains(s))
    except Exception as error:  # node went away mid-walk
        out.append(f"{'  ' * depth}ERR {error}")
        return
    count["nodes"] += 1
    count["named"] += bool(name)
    count["focusable"] += "F" in flags
    line = f"{'  ' * depth}{role} | {name} | {desc} | {flags}"
    if pattern is not None:
        if name and pattern.search(name) and not out:
            try:
                r = node.get_extents(Atspi.CoordType.SCREEN)
                out.append(f"{r.x + r.width // 2} {r.y + r.height // 2}")
            except Exception:
                pass
    elif mode == "tree" or "*" in flags:
        out.append(line.strip() if mode == "focus" else line)
    try:
        n = node.get_child_count()
    except Exception:
        n = 0
    for i in range(n):
        try:
            child = node.get_child_at_index(i)
        except Exception:
            child = None
        if child is not None:
            walk(child, depth + 1)


for app in apps:
    walk(app, 0)
if mode == "tree":
    out.append(f"# apps={len(apps)} nodes={count['nodes']} named={count['named']} focusable={count['focusable']}")
elif not out and mode == "focus":
    out.append("(nothing focused)")
print("\n".join(out))
