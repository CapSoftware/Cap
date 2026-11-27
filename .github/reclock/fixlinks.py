"""fixlinks.py <dir>: rewrites symlinks that point at a CI runner path into relative links inside <dir>."""
import os, sys

root = os.path.abspath(sys.argv[1])
fixed = 0
for d, dirs, files in os.walk(root):
    for n in dirs + files:
        p = os.path.join(d, n)
        if not os.path.islink(p):
            continue
        t = os.readlink(p)
        if not t.startswith("/Users/runner/"):
            continue
        marker = "Spacedrive.framework/"
        rel_in_fw = t.split(marker, 1)[1]
        fw = p[: p.index(marker) + len(marker)]
        target = os.path.join(fw, rel_in_fw)
        os.remove(p)
        os.symlink(os.path.relpath(target, os.path.dirname(p)), p)
        fixed += 1
print("fixed", fixed)
