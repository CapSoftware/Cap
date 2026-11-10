"""Compares two `cargo clippy --message-format=json` outputs and prints the
diagnostics only the first one has. Usage: clippy_diff.py <patched> <base>"""

import collections
import json
import sys


def diagnostics(path):
    found = collections.Counter()
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("reason") != "compiler-message":
                continue
            message = entry["message"]
            if message.get("level") not in ("warning", "error"):
                continue
            spans = [span for span in message.get("spans", []) if span.get("is_primary")]
            file = spans[0]["file_name"] if spans else ""
            code = (message.get("code") or {}).get("code", "")
            if not file and not code:
                continue
            found[(message["level"], code, file, message["message"])] += 1
    return found


patched, base = diagnostics(sys.argv[1]), diagnostics(sys.argv[2])
print(f"patched tree: {sum(patched.values())} diagnostics, without the device-lost patch: {sum(base.values())}")
for label, counter in (("patched tree", patched), ("without the device-lost patch", base)):
    by_file = collections.Counter()
    for (_, _, file, _), count in counter.items():
        by_file[file] += count
    print(f"{label}, by file: {dict(by_file)}")
new = patched - base
for (level, code, file, text), count in sorted(new.items()):
    print(f"NEW {level} {code} {file}: {text} (x{count})")
print(f"new with the device-lost patch: {sum(new.values())}")
sys.exit(1 if new else 0)
