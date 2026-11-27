"""burst.py <file> <burst_start_s> <burst_end_s>: the call tone (880 Hz) in a meeting's computer
audio around a burst of volume changes on another stream. 0.5 s Goertzel blocks: the mean before
the burst, the mean and the lowest block during it (and 2 s after), and how many of those blocks
fall below half the level before. Prints one JSON line."""
import json
import math
import struct
import subprocess
import sys

path, a, b = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    capture_output=True, check=True).stdout
x = struct.unpack(f"<{len(raw) // 4}f", raw)
RATE = 48000
N = RATE // 2
K = 2 * math.cos(2 * math.pi * 880 / RATE)


def blocks(lo, hi):
    out = []
    start = int(lo * RATE)
    while start + N <= min(len(x), int(hi * RATE)):
        s1 = s2 = 0.0
        for v in x[start:start + N]:
            s0 = v + K * s1 - s2
            s2, s1 = s1, s0
        out.append(2 * math.sqrt(max(s1 * s1 + s2 * s2 - K * s1 * s2, 0.0)) / N)
        start += N
    return out


before = blocks(3, a - 0.5)
during = blocks(a, b + 2)
mean_before = sum(before) / len(before) if before else 0.0
print(json.dumps({
    "file": path.rsplit("/", 1)[-1],
    "call880_before_mean": round(mean_before, 5),
    "call880_burst_mean": round(sum(during) / len(during), 5) if during else 0.0,
    "call880_burst_min": round(min(during), 5) if during else 0.0,
    "burst_blocks": len(during),
    "burst_blocks_below_half": sum(1 for v in during if v < mean_before / 2),
}))
