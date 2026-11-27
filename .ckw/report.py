#!/usr/bin/env python3
"""report.py <case dir>: what a gotcha scenario's meeting recorded (scratch, never ships).

Prints the timeline marks (seconds since recording began), the microphone and computer-audio
lines by when they were spoken, the health line changes and device messages from the app log,
the sources' health just before Stop, and the saved audio files' durations."""
import json, os, re, subprocess, sys

r = sys.argv[1]
marks = []
t0 = None
for line in open(os.path.join(r, "timeline.txt"), errors="replace"):
    parts = line.split(" ", 1)
    if len(parts) == 2 and parts[0].isdigit():
        at = int(parts[0])
        if t0 is None:
            t0 = at
        marks.append((at - t0) / 1000.0)
        print(f"mark {(at - t0) / 1000.0:6.1f}s {parts[1].strip()}")
    else:
        print("      " + line.rstrip())

try:
    s = json.load(open(os.path.join(r, "summary.json")))
except Exception as e:
    print("NO SUMMARY", e)
    s = {}
for source in ("mic", "system"):
    us = [u for u in s.get("utterances", []) if u.get("source") == source and u.get("final")]
    print(f"{source}: {len(us)} final lines")
    for u in us:
        print(f"  {u['startMs'] / 1000:6.1f}-{u['endMs'] / 1000:6.1f}s {u['text'][:70]}")
bs = s.get("beforeStop") or {}
print("before stop:", json.dumps(bs.get("active"), indent=None))
cs = bs.get("captureStats") or {}
print("capture stats:", json.dumps(cs))
print("durationMs:", s.get("durationMs"), "audio:", s.get("audio"))
print("cpuSeconds:", s.get("cpuSeconds"), "peakRssBytes:", s.get("peakRssBytes"))

pat = re.compile(r"meeting health line|microphone|Microphone|device|Device|reconnect|sample rate|stream error|No audio|restarting its capture|First audio callback|AUTO_MEETING: (going|woke|resumed)|moves|reopening|follows the call|back on the default output|call.s output|could not look for a call|moved off the output|computer audio capture|process loopback|looping back|loopback|panicked|thread .main|stderr|exited early|backtrace|exceptionlooked at the microphones|StopCapture|Resume", re.I)
print("app log:")
for line in open(os.path.join(r, "app.log"), errors="replace"):
    if pat.search(line):
        print("  " + line.rstrip()[:300])

for root, _, files in os.walk(r):
    for f in sorted(files):
        if f.endswith(".ogg"):
            p = os.path.join(root, f)
            try:
                d = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip()
            except Exception:
                d = "?"
            print(f"audio file {os.path.relpath(p, r)}: {d}s, {os.path.getsize(p)} bytes")
            try:
                raw = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-f", "f32le", "-ac", "1", "-ar", "8000", "-"],
                                     capture_output=True).stdout
                import array, math
                a = array.array("f"); a.frombytes(raw[: len(raw) // 4 * 4])
                win = 8000 * 5
                levels = []
                for i in range(0, len(a), win):
                    chunk = a[i:i + win]
                    rms = math.sqrt(sum(x * x for x in chunk) / max(1, len(chunk)))
                    levels.append("%3d" % max(-99, round(20 * math.log10(rms))) if rms > 0 else "-99")
                print("   dBFS per 5 s:", " ".join(levels))
            except Exception as e:
                print("   levels failed", e)
