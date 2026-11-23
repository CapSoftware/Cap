#!/usr/bin/env python3
"""AT-SPI helper for the header audit (Linux, accesskit_unix).

dump <pid>                 print role/name of every node in the app with that pid
press <pid> <name regex>   do the default action of the first visible node whose name matches
"""
import re
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


def walk(node, depth=0):
    if node is None or depth > 60:
        return
    yield node, depth
    try:
        count = node.get_child_count()
    except Exception:
        return
    for i in range(count):
        try:
            child = node.get_child_at_index(i)
        except Exception:
            continue
        yield from walk(child, depth + 1)


def app_for(pid, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            try:
                if app is not None and app.get_process_id() == pid:
                    return app
            except Exception:
                pass
        time.sleep(0.5)
    return None


def name(node):
    try:
        return node.get_name() or ""
    except Exception:
        return ""


def role(node):
    try:
        return node.get_role_name() or ""
    except Exception:
        return ""


def main():
    cmd, pid = sys.argv[1], int(sys.argv[2])
    app = app_for(pid)
    if app is None:
        print("NO_APP: the process is not on the accessibility bus")
        return 2
    if cmd == "dump":
        for node, depth in walk(app):
            n = name(node)
            if n or depth < 3:
                print("  " * depth + f"{role(node)}: {n}")
        return 0
    rx = re.compile(sys.argv[3])
    end = time.time() + 15
    while time.time() < end:
        for node, _ in walk(app):
            if rx.search(name(node)):
                try:
                    action = node.get_action_iface()
                    if action is not None and action.get_n_actions() > 0:
                        action.do_action(0)
                        print(f"PRESSED {role(node)}: {name(node)}")
                        return 0
                except Exception as e:
                    print("action failed", e)
        time.sleep(0.5)
    print(f"NOT_FOUND {sys.argv[3]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
