#!/usr/bin/env python3
"""Lets cargo reuse cached builds of unchanged workspace crates in CI.

Cargo decides whether a workspace crate is fresh by comparing the mtimes of
its source files with its last build. A fresh checkout gives every file the
current time, so every workspace crate would rebuild even when the Rust cache
holds an up-to-date build.

  mtime.py record <manifest>   after a build: record the git blob id of every
                               tracked file (stored inside the cached target)
  mtime.py apply <manifest>    before building: files whose blob id matches
                               the manifest get an old fixed mtime, so cargo
                               sees them as unchanged; every other file keeps
                               the checkout time and its crate rebuilds. With
                               no manifest and no cached build (cold build)
                               every file gets the fixed time; a cached build
                               without a manifest is not trusted, and every
                               file gets the current time.

Only content equality is trusted, never commit times, so a stale build cannot
be reused for changed code.
"""

import os
import subprocess
import sys

OLD = 946684800  # 2000-01-01


def blobs():
    out = subprocess.run(
        ["git", "ls-files", "-s", "-z"], check=True, capture_output=True
    ).stdout.decode("utf-8", "surrogateescape")
    entries = {}
    for item in out.split("\0"):
        if not item:
            continue
        meta, path = item.split("\t", 1)
        entries[path] = meta.split()[1]
    # The index ids only describe the files when the work tree matches it.
    dirty = subprocess.run(
        ["git", "diff", "--name-only", "-z"], check=True, capture_output=True
    ).stdout.decode("utf-8", "surrogateescape")
    for path in filter(None, dirty.split("\0")):
        entries[path] = "dirty"
    return entries


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("record", "apply"):
        sys.exit(__doc__)
    command, manifest = sys.argv[1], sys.argv[2]
    current = blobs()
    if command == "record":
        os.makedirs(os.path.dirname(os.path.abspath(manifest)), exist_ok=True)
        with open(manifest, "w", encoding="utf-8", errors="surrogateescape") as f:
            for path, blob in sorted(current.items()):
                f.write(f"{blob} {path}\n")
        print(f"recorded {len(current)} files in {manifest}")
        return
    saved = None
    if os.path.exists(manifest):
        saved = {}
        with open(manifest, encoding="utf-8", errors="surrogateescape") as f:
            for line in f:
                blob, _, path = line.rstrip("\n").partition(" ")
                saved[path] = blob
    elif os.path.isdir(os.path.dirname(manifest)) and os.listdir(os.path.dirname(manifest)):
        # A cached build saved without a manifest: nothing says which sources
        # it was built from, and the fixed time would make cargo reuse all of
        # it. Every file gets the current time, so every crate rebuilds.
        print(f"no manifest at {manifest} beside a cached build: rebuilding every crate")
        for path in current:
            if os.path.isfile(path) and not os.path.islink(path):
                os.utime(path, None)
        return
    else:
        # Cold build: give every file the fixed time too. Build scripts
        # without rerun-if-changed fingerprint the newest mtime of their
        # package by equality, so the build that gets cached must see the
        # same times the next run will set.
        print(f"no manifest at {manifest}: cold build, normalising every file")
    same = changed = 0
    for path, blob in current.items():
        if (
            blob != "dirty"
            and (saved is None or saved.get(path) == blob)
            and os.path.isfile(path)
            and not os.path.islink(path)
        ):
            os.utime(path, (OLD, OLD))
            same += 1
        else:
            changed += 1
    print(f"{same} files unchanged since the cached build, {changed} changed or new")


if __name__ == "__main__":
    main()
