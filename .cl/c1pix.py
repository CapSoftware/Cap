#!/usr/bin/env python3
"""c1pix.py <out dir> <os>: per surface, pixels (>1 level) differing base vs base, head vs head and
base vs head, from shots p-<surface>-<arm>-<k>.png (no reader) and t-<surface>-<arm>.png (reader).
On macOS (full-screen shots) only pixels inside the app's windows minus a 14 px edge are counted,
from the AXWindow frames in the reader-on head tree; the rest of the screen is reported apart."""
import glob
import os
import re
import sys

from PIL import Image, ImageChops

out, osname = sys.argv[1], sys.argv[2]
shots = os.path.join(out, "shots")


def frames(surface):
    rects = []
    path = os.path.join(out, "trees", f"t-{surface}-head.txt")
    if not os.path.exists(path):
        return rects
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.lstrip().startswith("AXWindow"):
            m = re.search(r"\| (-?\d+),(-?\d+),(\d+),(\d+)\s*$", line.rstrip())
            if m:
                x, y, w, h = map(int, m.groups())
                if w > 40 and h > 40:
                    rects.append((x + 14, y + 14, x + w - 14, y + h - 14))
    return rects


def diff(a, b, rects):
    A = Image.open(a).convert("RGB")
    B = Image.open(b).convert("RGB")
    if A.size != B.size:
        return f"SIZE {A.size} vs {B.size}"
    d = ImageChops.difference(A, B).convert("L").point(lambda v: 255 if v > 1 else 0)
    if not rects:
        return str(sum(1 for v in d.getdata() if v))
    inside = 0
    for x0, y0, x1, y1 in rects:
        crop = d.crop((max(x0, 0), max(y0, 0), min(x1, A.size[0]), min(y1, A.size[1])))
        inside += sum(1 for v in crop.getdata() if v)
    total = sum(1 for v in d.getdata() if v)
    return f"{inside} in-window ({total} whole screen)"


surfaces = sorted({re.match(r"p-(.+)-(base|head)-\d+\.png", os.path.basename(p)).group(1)
                   for p in glob.glob(os.path.join(shots, "p-*-*-*.png"))})
for s in surfaces:
    rects = frames(s) if osname == "mac" else []
    def f(arm, k):
        return os.path.join(shots, f"p-{s}-{arm}-{k}.png")
    have = all(os.path.exists(f(a, k)) for a, k in (("base", 1), ("head", 2), ("base", 3), ("head", 4)))
    if not have:
        print(f"{s}: missing shots")
        continue
    row = [f"bb {diff(f('base', 1), f('base', 3), rects)}",
           f"hh {diff(f('head', 2), f('head', 4), rects)}",
           f"bh {diff(f('base', 1), f('head', 2), rects)} / {diff(f('base', 3), f('head', 4), rects)}"]
    tb, th = os.path.join(shots, f"t-{s}-base.png"), os.path.join(shots, f"t-{s}-head.png")
    if os.path.exists(tb) and os.path.exists(th):
        row.append(f"reader bh {diff(tb, th, rects)}")
    print(f"{s}: " + " | ".join(row))
