#!/usr/bin/env python3
"""nwords.py <case dir>: screen-reader words in a meeting's computer audio (scratch, never ships).
Counts "hello" and "world" (what Narrator echoes from the typed text) in the computer-audio
transcript, and prints the computer audio's speech time, file sizes, CPU and the app's thread
count from the summary."""
import json
import os
import re
import sys

r = sys.argv[1]
try:
    s = json.load(open(os.path.join(r, "summary.json")))
except Exception as error:
    print("NO SUMMARY", error)
    sys.exit(0)
words = 0
for u in s.get("utterances", []):
    if u.get("source") == "system" and u.get("final"):
        words += len(re.findall(r"\b(hello|world|reader|aloud)\b", u.get("text", ""), re.I))
sizes = []
for root, _, files in os.walk(os.path.join(r, "data")):
    for f in files:
        if f.startswith("others") and f.endswith(".ogg"):
            sizes.append(os.path.getsize(os.path.join(root, f)))
cs = (s.get("beforeStop") or {}).get("captureStats") or {}
print(f"reader words in computer audio: {words}; systemSpeechMs {s.get('systemSpeechMs')}; "
      f"others.ogg bytes {sizes}; durationMs {s.get('durationMs')}; cpuSeconds {s.get('cpuSeconds')}; "
      f"capture {json.dumps(cs)[:300]}")
