"""tones.py <file> <move_s>: per-window level of two test tones (440 Hz music, 880 Hz call) in a
meeting's computer audio, before and after the call moved to another output at <move_s> seconds
into the recording. Goertzel on 48 kHz mono float WAV (decoded by ffmpeg). Prints one JSON line."""
import json
import math
import struct
import subprocess
import sys

path, move = sys.argv[1], float(sys.argv[2])
raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    capture_output=True, check=True).stdout
x = struct.unpack(f"<{len(raw) // 4}f", raw)
RATE = 48000


def level(freq, a, b):
    """Mean Goertzel amplitude of `freq` over 0.5 s blocks in [a, b) seconds (0 when empty)."""
    out = []
    n = RATE // 2
    k = 2 * math.cos(2 * math.pi * freq / RATE)
    start = int(a * RATE)
    while start + n <= min(len(x), int(b * RATE)):
        s1 = s2 = 0.0
        for v in x[start:start + n]:
            s0 = v + k * s1 - s2
            s2, s1 = s1, s0
        power = s1 * s1 + s2 * s2 - k * s1 * s2
        out.append(2 * math.sqrt(max(power, 0.0)) / n)
        start += n
    return round(sum(out) / len(out), 5) if out else 0.0


dur = len(x) / RATE
print(json.dumps({
    "file": path.rsplit("/", 1)[-1],
    "seconds": round(dur, 1),
    "music440_before": level(440, 3, move - 2),
    "music440_after": level(440, move + 6, dur - 2),
    "call880_before": level(880, 3, move - 2),
    "call880_after": level(880, move + 6, dur - 2),
}))
