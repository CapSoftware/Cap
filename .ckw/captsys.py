"""captsys.py <case dir>: the meeting's computer-audio capture counters from summary.json (gaps,
padding, drops, restarts) and the audio file lengths. Scratch, never ships."""
import json
import os
import sys

try:
    s = json.load(open(os.path.join(sys.argv[1], "summary.json")))
except Exception as error:
    print("no summary", error)
    sys.exit(0)
cs = (s.get("beforeStop") or {}).get("captureStats") or {}
system = cs.get("system") or {}
keys = ("gaps", "paddedMs", "skippedMs", "droppedBatches", "droppedSegments", "restarts", "writtenMs", "batches")
print("computer audio capture: " + ", ".join(f"{k}={system.get(k)}" for k in keys if k in system)
      + f"; audio files {s.get('audio')}")
