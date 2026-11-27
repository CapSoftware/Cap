"""b2bdocs.py docs|gap <documents dir>: what the scratch library holds after a back-to-back run."""
import json
import os
import sys
from datetime import datetime


def ts(v):
    return datetime.fromisoformat(v[:26].rstrip("Z") + "+00:00") if v else None


def metas(root):
    out = []
    for d in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        p = os.path.join(root, d, "doc.json")
        if os.path.isfile(p):
            out.append((d, json.load(open(p))))
    return out


mode, root = sys.argv[1], sys.argv[2]
docs = metas(root)
if mode == "docs":
    for d, j in docs:
        m = j.get("meeting") or {}
        e = m.get("event") or {}
        tx = os.path.join(root, d, "transcript.jsonl")
        n = sum(1 for _ in open(tx)) if os.path.isfile(tx) else 0
        s, es = ts(m.get("startedAt")), ts(e.get("start"))
        late = f" start-vs-event={(s - es).total_seconds():+.1f}s" if s and es else ""
        files = sorted(f for f in os.listdir(os.path.join(root, d)) if f != "doc.json")
        audio = [(a["source"], a.get("durationMs")) for a in m.get("audio") or []]
        print(f"doc {d[:8]} title={j.get('title')!r} event={e.get('title')!r} transcript_lines={n}"
              f" chars={m.get('transcriptChars')} stop={m.get('stopReason')} started={m.get('startedAt')}"
              f" ended={m.get('endedAt')}{late} audio={audio} files={files}")
else:
    ms = [j.get("meeting") or {} for _, j in docs]
    for a, b in zip(ms, ms[1:]):
        if a.get("endedAt") and b.get("startedAt"):
            gap = (ts(b["startedAt"]) - ts(a["endedAt"])).total_seconds() * 1000
            print(f"boundary gap {gap:.0f} ms (A stop={a.get('stopReason')})")
