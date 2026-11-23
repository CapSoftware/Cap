#!/usr/bin/env python3
"""fixfw.py <dir>...: rewrite absolute symlinks inside each Spacedrive.framework
under <dir> to the same place relative to the framework, so a framework copied
off its build runner resolves on another machine."""
import os
import sys

MARK = "Spacedrive.framework/"
fixed = broken = 0
for top in sys.argv[1:]:
    for root, dirs, files in os.walk(top):
        for name in dirs + files:
            path = os.path.join(root, name)
            if not os.path.islink(path):
                continue
            target = os.readlink(path)
            if not os.path.isabs(target) or MARK not in target or MARK not in path:
                continue
            fw = path[: path.index(MARK) + len(MARK)]
            inside = target[target.index(MARK) + len(MARK):]
            new = os.path.relpath(os.path.join(fw, inside), os.path.dirname(path))
            os.unlink(path)
            os.symlink(new, path)
            fixed += 1
for top in sys.argv[1:]:
    for root, dirs, files in os.walk(top):
        for name in dirs + files:
            path = os.path.join(root, name)
            if os.path.islink(path) and MARK in path and not os.path.exists(path):
                broken += 1
                print("still dangling:", path, "->", os.readlink(path))
print(f"fixfw: {fixed} links made relative, {broken} still dangling")
sys.exit(1 if broken else 0)
