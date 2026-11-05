#!/usr/bin/env python3
"""Press a button in another app's dialog through the accessibility tree,
the action a pointer click performs.

Usage: atspi-press.py <app or window name regex> <button name regex> [timeout seconds]
"""
import re
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


def walk(node, depth=0):
    if node is None or depth > 40:
        return
    yield node
    for index in range(node.get_child_count()):
        try:
            child = node.get_child_at_index(index)
        except Exception:
            continue
        yield from walk(child, depth + 1)


def find(scope_re, button_re):
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
        for node in walk(app):
            try:
                role = node.get_role()
                name = node.get_name() or ""
            except Exception:
                continue
            # Qt reports its buttons with the plain "button" role.
            is_button = role in (Atspi.Role.PUSH_BUTTON, Atspi.Role.TOGGLE_BUTTON) or (
                node.get_role_name() == "button"
            )
            if is_button and button_re.search(name):
                return node
    return None


def main() -> int:
    scope_re = re.compile(sys.argv[1])
    button_re = re.compile(sys.argv[2])
    deadline = time.time() + (float(sys.argv[3]) if len(sys.argv) > 3 else 10)
    while time.time() < deadline:
        button = find(scope_re, button_re)
        if button is not None:
            action = button.get_action_iface()
            if action is not None and action.get_n_actions() > 0:
                action.do_action(0)
                print(f"pressed '{button.get_name()}' in {sys.argv[1]}")
                return 0
        time.sleep(0.5)
    print(f"no button {sys.argv[2]} in {sys.argv[1]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
