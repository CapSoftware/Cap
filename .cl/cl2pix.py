#!/usr/bin/env python3
"""cl2pix.py <a.png> <b.png>: how many pixels differ by more than 1 level (size mismatch reported)."""
import sys

try:
    from PIL import Image, ImageChops
except ImportError:
    print("no PIL")
    sys.exit(0)
try:
    a = Image.open(sys.argv[1]).convert("RGB")
    b = Image.open(sys.argv[2]).convert("RGB")
except Exception as error:  # a missing shot
    print(f"unreadable ({error.__class__.__name__})")
    sys.exit(0)
if a.size != b.size:
    print(f"size {a.size} vs {b.size}")
    sys.exit(0)
diff = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 1 else 0)
print(f"changed_px={sum(1 for v in diff.getdata() if v)}")
