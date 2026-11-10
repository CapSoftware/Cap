#!/usr/bin/env python3
"""Print the buttons, entries and list rows of an app's windows with their
sensitivity, for the harness's own evidence.

Usage: atspi-dump.py <app or window name regex>
"""
import re
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


def walk(node, depth=0):
    if node is None or depth > 40:
        return
    yield node, depth
    for index in range(node.get_child_count()):
        try:
            child = node.get_child_at_index(index)
        except Exception:
            continue
        yield from walk(child, depth + 1)


def main() -> int:
    scope_re = re.compile(sys.argv[1])
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app is None:
            continue
        names = [app.get_name() or ""]
        for window_index in range(app.get_child_count()):
            window = app.get_child_at_index(window_index)
            names.append((window.get_name() if window else "") or "")
        if not any(scope_re.search(name) for name in names):
            continue
        print(f"app {names}")
        for node, depth in walk(app):
            try:
                role = node.get_role_name()
                name = node.get_name() or ""
                states = node.get_state_set()
                sensitive = states.contains(Atspi.StateType.SENSITIVE)
                showing = states.contains(Atspi.StateType.SHOWING)
            except Exception:
                continue
            if not showing or not name:
                continue
            if role in ("button", "push button", "toggle button", "text", "entry", "table cell", "list item", "label", "heading", "frame", "dialog", "window"):
                print(f"{'  ' * min(depth, 12)}{role} '{name}' sensitive={sensitive}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
