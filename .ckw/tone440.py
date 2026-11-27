"""tone440.py <case dir>: how much of the 440 Hz music tone (played on the second output) is in a
meeting's computer audio: mean Goertzel amplitude over 0.5 s blocks of every others*.ogg under
<case dir>/data, plus the same for a quiet reference band (1234 Hz). Scratch, never ships."""
import math
import os
import struct
import subprocess
import sys

RATE = 16000
N = RATE // 2


def level(x, freq):
    k = 2 * math.cos(2 * math.pi * freq / RATE)
    out = []
    for start in range(0, len(x) - N, N):
        s1 = s2 = 0.0
        for v in x[start:start + N]:
            s0 = v + k * s1 - s2
            s2, s1 = s1, s0
        out.append(2 * math.sqrt(max(s1 * s1 + s2 * s2 - k * s1 * s2, 0.0)) / N)
    return sum(out) / len(out) if out else 0.0


found = False
for root, _, files in os.walk(os.path.join(sys.argv[1], "data")):
    for f in sorted(files):
        if f.startswith("others") and f.endswith(".ogg"):
            raw = subprocess.run(["ffmpeg", "-v", "error", "-i", os.path.join(root, f), "-ac", "1", "-ar", str(RATE),
                                  "-f", "f32le", "-"], capture_output=True).stdout
            x = struct.unpack(f"<{len(raw) // 4}f", raw)
            print(f"music 440 Hz in computer audio: {level(x, 440):.5f} (reference 1234 Hz {level(x, 1234):.5f}, {len(x) / RATE:.0f} s, {f})")
            found = True
if not found:
    print("music 440 Hz in computer audio: no others audio")
