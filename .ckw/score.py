"""score.py <case dir> <truth.json> [<call offset s>]: word recall of the computer-audio track
against the fixture's call (system) side, and the mic/system lag at the start and the end.
Scratch, never ships.

Recall: of the truth words spoken while the case ran (the call plays from the fixture's start
when the case's call began), how many appear in the system transcript (multiset match).
Lag: cross-correlation of the saved mic and system tracks (8 kHz) over the first and last 30 s.
"""
import collections, glob, json, os, re, subprocess, sys

import numpy as np

r, truth_path = sys.argv[1], sys.argv[2]
offset = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
s = json.load(open(os.path.join(r, "summary.json")))
truth = json.load(open(truth_path))
dur = (s.get("durationMs") or 0) / 1000.0
words = lambda t: re.findall(r"[a-z']+", t.lower())
spoken = collections.Counter()
for u in truth["utterances"]:
    if u.get("track") != "system":
        continue
    # The call loops: every play of the fixture that falls inside the case.
    length = truth["duration_ms"] / 1000.0
    start = u["start_ms"] / 1000.0 + offset
    while start < dur:
        if start + (u["end_ms"] - u["start_ms"]) / 1000.0 <= dur:
            spoken.update(words(u["text"]))
        start += length
heard = collections.Counter()
for u in s.get("utterances", []):
    if u.get("source") == "system" and u.get("final"):
        heard.update(words(u["text"]))
matched = sum(min(n, heard[w]) for w, n in spoken.items())
total = sum(spoken.values())
print(f"system recall {matched}/{total} = {matched / max(1, total):.3f} (offset {offset:.1f} s, {dur:.0f} s)")


def track(name):
    paths = glob.glob(os.path.join(r, "data", "documents", "*", "audio", name))
    if not paths:
        return None
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", paths[0], "-f", "f32le", "-ac", "1", "-ar", "8000", "-"],
                         capture_output=True).stdout
    return np.frombuffer(raw[: len(raw) // 4 * 4], dtype=np.float32)


def lag(a, b, lo, hi, rate=8000, limit=1.0):
    a, b = a[int(lo * rate):int(hi * rate)], b[int(lo * rate):int(hi * rate)]
    n = min(len(a), len(b))
    if n < rate:
        return None
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    size = 1 << int(np.ceil(np.log2(2 * n)))
    c = np.fft.irfft(np.fft.rfft(a, size) * np.conj(np.fft.rfft(b, size)), size)
    k = int(limit * rate)
    window = np.concatenate([c[-k:], c[: k + 1]])
    best = int(np.argmax(np.abs(window))) - k
    peak = float(np.abs(window).max() / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
    return best * 1000.0 / rate, peak


mic, system = track("you.ogg"), track("others.ogg")
if mic is not None and system is not None:
    end = min(len(mic), len(system)) / 8000.0
    for name, (lo, hi) in (("start", (5, 35)), ("end", (end - 35, end - 5))):
        found = lag(mic, system, lo, hi)
        print(f"mic/system lag at {name}: " + ("n/a" if not found else f"{found[0]:+.1f} ms (correlation {found[1]:.2f})"))
