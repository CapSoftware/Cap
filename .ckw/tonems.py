"""tonems.py <case dir>: for a case whose call page played a 440 Hz tone on another output
(call.html &tone=..&toneat=N, read from the timeline's "call plays (<query>)" mark), how long that
tone is in the meeting's computer audio: 50 ms blocks of every others*.ogg under <case dir>/data,
Goertzel amplitude at 440 Hz, counted as recorded above LEAK (the rig's own floor through the
virtual devices is about 0.02; the tone read straight is about 0.25). Scratch, never ships."""
import math
import os
import re
import struct
import subprocess
import sys
from urllib.parse import parse_qs, unquote

RATE = 16000
N = RATE // 20
LEAK = 0.08

d = sys.argv[1]
marks = []
for line in open(os.path.join(d, "timeline.txt"), errors="replace"):
    p = line.strip().split(" ", 1)
    if len(p) == 2 and p[0].isdigit():
        marks.append((int(p[0]) / 1000, p[1]))
if not marks:
    sys.exit()
t0 = marks[0][0]
call = next(((t, w) for t, w in marks if w.startswith("call plays (")), None)
if not call:
    sys.exit()
query = parse_qs(unquote(re.sub(r"^call plays \((.*)\)$", r"\1", call[1])))
if "tone" not in query:
    sys.exit()
start = call[0] - t0 + float(query.get("toneat", ["0"])[0])


def levels(x):
    k = 2 * math.cos(2 * math.pi * 440 / RATE)
    out = []
    for at in range(0, len(x) - N, N):
        s1 = s2 = 0.0
        for v in x[at:at + N]:
            s0 = v + k * s1 - s2
            s2, s1 = s1, s0
        out.append(2 * math.sqrt(max(s1 * s1 + s2 * s2 - k * s1 * s2, 0.0)) / N)
    return out


for root, _, files in os.walk(os.path.join(d, "data")):
    for f in sorted(files):
        if not (f.startswith("others") and f.endswith(".ogg")):
            continue
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", os.path.join(root, f), "-ac", "1", "-ar", str(RATE),
                              "-f", "f32le", "-"], capture_output=True).stdout
        x = struct.unpack(f"<{len(raw) // 4}f", raw)
        lv = levels(x)
        first = int(start * 20)
        after = [(i, v) for i, v in enumerate(lv) if i >= first]
        leak = [i for i, v in after if v > LEAK]
        before = sorted(lv[40:first]) or [0.0]
        tail = sorted(v for i, v in after if i >= (leak[-1] + 1 if leak else first)) or [0.0]
        span = f"first +{(leak[0] - first) / 20:.2f} s, last +{(leak[-1] - first) / 20:.2f} s after it starts" if leak else "never"
        print(f"tone from the call's page on the other output starts at {start:.1f} s: recorded above {LEAK} for {len(leak) * 50} ms ({span}); "
              f"440 Hz median before {before[len(before) // 2]:.4f}, after the leak {tail[len(tail) // 2]:.4f}, {len(after) / 20:.0f} s after start ({f})")
