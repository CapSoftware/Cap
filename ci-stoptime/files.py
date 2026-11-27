#!/usr/bin/env python3
"""files.py DIR...: per recording, display.mp4 packet count, duration, stts entries; writes $RUNNER_TEMP/files.txt."""
import os, struct, sys

try:
    import av
except ImportError:
    av = None

out = []
for top in sys.argv[1:]:
    for run in sorted(os.listdir(top)) if os.path.isdir(top) else []:
        f = os.path.join(top, run, "rec.cap", "content", "segments", "segment-0", "display.mp4")
        if not os.path.isfile(f):
            continue
        d = open(f, "rb").read()
        i = d.find(b"stts")
        n = struct.unpack(">I", d[i + 8:i + 12])[0] if i > 0 else -1
        pk = dur = None
        if av:
            c = av.open(f)
            pk = sum(1 for p in c.demux(c.streams.video[0]) if p.size)
            dur = c.duration
            c.close()
        out.append(f"{os.path.basename(top)} {run} size={len(d)} stts={n} packets={pk} duration_us={dur}")
text = "\n".join(out)
print(text)
open(os.path.join(os.environ.get("RUNNER_TEMP", "."), "files.txt"), "w").write(text + "\n")
