#!/usr/bin/env python3
"""openbench.py DIR...: for each recorded display.mp4, time N opens with and without fpsprobesize=0 (PyAV), interleaved."""
import glob, os, statistics as st, sys, time
import av

N = 30
rows = []
for top in sys.argv[1:]:
    for f in sorted(glob.glob(os.path.join(top, "*", "rec.cap", "content", "segments", "segment-0", "display.mp4"))):
        a, b = [], []
        for i in range(N):
            for k in ((0, 1) if i % 2 else (1, 0)):
                t = time.perf_counter()
                c = av.open(f, options={"fpsprobesize": "0"}) if k else av.open(f)
                dur = c.duration
                c.close()
                (b if k else a).append(time.perf_counter() - t)
                durs = locals().setdefault("durs", set()); durs.add(dur)
            assert len(durs) == 1, (f, durs)
            durs.clear()
        rows.append((f, st.median(a) * 1000, st.median(b) * 1000))
        print(f"{f.split(os.sep)[-6]}/{f.split(os.sep)[-5]} default {st.median(a)*1000:.2f} ms  fps0 {st.median(b)*1000:.2f} ms  same duration")
if rows:
    print(f"ALL median default {st.median(r[1] for r in rows):.2f} ms fps0 {st.median(r[2] for r in rows):.2f} ms over {len(rows)} files x {N} opens")
