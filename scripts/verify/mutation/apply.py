#!/usr/bin/env python3
"""apply.py validate | list [platform] | apply ID | revert ID | show ID | json

Applies one catalogue mutation (exact replacements, every occurrence count
checked) to the working tree; `revert` restores the saved original.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
from mutations import M  # noqa: E402

BY_ID = {m["id"]: m for m in M}


def check(m, text=None):
    path = os.path.join(ROOT, m["file"])
    text = open(path, encoding="utf-8").read() if text is None else text
    problems = []
    for e in m["edits"]:
        n = text.count(e["old"])
        if n != e["count"]:
            problems.append(f'{m["id"]}: expected {e["count"]} of {e["old"][:70]!r}, found {n}')
    return problems


def backup_path(m):
    return os.path.join(ROOT, "target", "mutation-originals", m["id"])


def apply(m):
    path = os.path.join(ROOT, m["file"])
    text = open(path, encoding="utf-8").read()
    problems = check(m, text)
    if problems:
        raise SystemExit("\n".join(problems))
    os.makedirs(os.path.dirname(backup_path(m)), exist_ok=True)
    open(backup_path(m), "w", encoding="utf-8").write(text)
    for e in m["edits"]:
        text = text.replace(e["old"], e["new"])
    open(path, "w", encoding="utf-8").write(text)
    print(m["file"])


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "validate"
    if cmd == "validate":
        ids = [m["id"] for m in M]
        dup = {i for i in ids if ids.count(i) > 1}
        problems = [f"duplicate id {i}" for i in dup]
        for m in M:
            problems += check(m)
        print("\n".join(problems) if problems else f"{len(M)} mutations OK")
        sys.exit(1 if problems else 0)
    if cmd == "list":
        platform = sys.argv[2] if len(sys.argv) > 2 else None
        for m in M:
            if platform is None or platform in m["platforms"]:
                print(m["id"])
        return
    if cmd == "apply":
        apply(BY_ID[sys.argv[2]])
        return
    if cmd == "revert":
        m = BY_ID[sys.argv[2]]
        original = open(backup_path(m), encoding="utf-8").read()
        open(os.path.join(ROOT, m["file"]), "w", encoding="utf-8").write(original)
        os.remove(backup_path(m))
        return
    if cmd == "show":
        print(json.dumps(BY_ID[sys.argv[2]], indent=2))
        return
    if cmd == "json":
        print(json.dumps(M, indent=1))
        return
    raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
