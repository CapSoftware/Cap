#!/usr/bin/env python3
"""Lets cargo reuse cached builds of unchanged workspace crates in CI.

Cargo decides whether a workspace crate is fresh by comparing the mtimes of
its source files with its last build. A fresh checkout gives every file the
current time, so every workspace crate would rebuild even when the Rust cache
holds an up-to-date build.

  mtime.py record <manifest>   after a build: record the git blob id of every
                               tracked file (stored inside the cached target),
                               and for every build of a workspace crate in the
                               cached target the blob ids it was built from
  mtime.py apply <manifest>    before building: drop every cached build of a
                               workspace crate whose sources differ from the
                               ones it was built from, then give files whose
                               blob id matches the manifest an old fixed
                               mtime, so cargo sees them as unchanged; every
                               other file keeps the checkout time and its
                               crate rebuilds. With no manifest and no cached
                               build (cold build) every file gets the fixed
                               time; a cached build without a manifest is not
                               trusted, and every file gets the current time.

Only content equality is trusted, never commit times, so a stale build cannot
be reused for changed code.

The manifest alone only describes the builds the last run made. The cached
target also keeps builds of the same crate with other features, made on
earlier days from older sources, and the fixed mtime makes those look fresh
too: a run that needs one of them would link a stale crate. So each build
(one .fingerprint directory) carries its own sources in the ledger beside the
manifest: a build made by this run (fingerprint written after the start
marker apply leaves) is recorded with the current blob ids, any other keeps
its earlier entry, and a build without an entry is never trusted.
"""

import json
import os
import re
import shutil
import subprocess
import sys

OLD = 946684800  # 2000-01-01
LEDGER = "verify-unit-sources.json"
MARKER = "verify-build-start"


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


def rel(path, roots):
    """Repo-relative '/' path, or None outside the repo. rustc writes the
    paths of workspace crates relative to the workspace root (the cwd)."""
    path = os.path.normpath(os.path.join(os.getcwd(), path))
    folded = os.path.normcase(path)
    for root in roots:
        if folded.startswith(root):
            return path[len(root):].replace(os.sep, "/")
    return None


def workspace_units(target):
    """(fingerprint dir name, package dir) of every workspace crate build."""
    meta = json.loads(
        subprocess.run(
            ["cargo", "metadata", "--no-deps", "--format-version", "1", "--offline"],
            check=True,
            capture_output=True,
        ).stdout
    )
    roots = {os.path.normcase(os.path.join(r, "")) for r in (os.getcwd(), os.path.realpath(os.getcwd()))}
    packages = {
        p["name"]: rel(os.path.dirname(p["manifest_path"]), roots) or ""
        for p in meta["packages"]
    }
    fingerprints = os.path.join(target, ".fingerprint")
    units = []
    for name in sorted(os.listdir(fingerprints)) if os.path.isdir(fingerprints) else []:
        match = re.fullmatch(r"(.+)-([0-9a-f]{16})", name)
        if match and match.group(1) in packages:
            units.append((name, packages[match.group(1)]))
    return units, roots


def sources(target, unit, package_dir, package_files, dep_index, current, roots):
    """Tracked files a build depends on: its package plus what rustc and the
    build script reported (files outside the package, include_str! etc.)."""
    files = set(package_files)
    dep_files = list(dep_index.get(unit.rsplit("-", 1)[1], ()))
    build = os.path.join(target, "build", unit)
    if os.path.isdir(build):
        dep_files += [os.path.join(build, f) for f in os.listdir(build) if f.endswith(".d")]
    for dep_file in dep_files:
        with open(dep_file, encoding="utf-8", errors="surrogateescape") as f:
            for token in re.split(r"(?<!\\)\s+", f.read()):
                path = rel(token.replace("\\ ", " ").rstrip(":"), roots) if token else None
                if path in current:
                    files.add(path)
    output = os.path.join(build, "output")
    if os.path.isfile(output):
        with open(output, encoding="utf-8", errors="surrogateescape") as f:
            for line in f:
                match = re.match(r"cargo::?rerun-if-changed=(.+)", line.strip())
                if not match:
                    continue
                path = rel(os.path.join(package_dir, match.group(1)), roots)
                if path is not None:
                    files.update(p for p in current if p == path or p.startswith(path.rstrip("/") + "/"))
    return {path: current[path] for path in sorted(files)}


def newest(directory):
    return max((e.stat().st_mtime_ns for e in os.scandir(directory)), default=0)


def record_units(target, current):
    ledger_path = os.path.join(target, LEDGER)
    marker = os.path.join(target, MARKER)
    start = os.stat(marker).st_mtime_ns if os.path.exists(marker) else None
    old = {}
    if os.path.exists(ledger_path):
        with open(ledger_path, encoding="utf-8") as f:
            old = json.load(f)
    units, roots = workspace_units(target)
    # rustc's dep-info of a build: deps/<crate>-<hash>.d, hash as in .fingerprint.
    dep_index = {}
    deps = os.path.join(target, "deps")
    for name in os.listdir(deps) if os.path.isdir(deps) else []:
        if name.endswith(".d"):
            dep_index.setdefault(name[:-2].rsplit("-", 1)[-1], []).append(os.path.join(deps, name))
    package_files = {}
    ledger = {}
    built = 0
    for unit, package_dir in units:
        if start is not None and newest(os.path.join(target, ".fingerprint", unit)) >= start:
            if package_dir not in package_files:
                prefix = package_dir + "/" if package_dir else ""
                package_files[package_dir] = [p for p in current if p.startswith(prefix)]
            ledger[unit] = sources(
                target, unit, package_dir, package_files[package_dir], dep_index, current, roots
            )
            built += 1
        elif unit in old:
            ledger[unit] = old[unit]
    with open(ledger_path, "w", encoding="utf-8") as f:
        json.dump(ledger, f, separators=(",", ":"), sort_keys=True)
    print(f"recorded the sources of {len(ledger)} workspace crate builds ({built} built by this run)")


def drop_stale_units(target, current):
    ledger_path = os.path.join(target, LEDGER)
    ledger = {}
    if os.path.exists(ledger_path):
        with open(ledger_path, encoding="utf-8") as f:
            ledger = json.load(f)
    else:
        print(f"no {LEDGER} beside the cached build: rebuilding every workspace crate")
    units, _ = workspace_units(target)
    dropped = 0
    for unit, _ in units:
        entry = ledger.get(unit)
        if entry is None or any(b == "dirty" or current.get(p) != b for p, b in entry.items()):
            shutil.rmtree(os.path.join(target, ".fingerprint", unit))
            dropped += 1
    print(f"{len(units) - dropped} cached workspace crate builds kept, {dropped} not built from these sources dropped")


def mark_start(target):
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, MARKER), "w", encoding="utf-8"):
        pass


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("record", "apply"):
        sys.exit(__doc__)
    command, manifest = sys.argv[1], sys.argv[2]
    target = os.path.dirname(os.path.abspath(manifest))
    current = blobs()
    if command == "record":
        os.makedirs(target, exist_ok=True)
        with open(manifest, "w", encoding="utf-8", errors="surrogateescape") as f:
            for path, blob in sorted(current.items()):
                f.write(f"{blob} {path}\n")
        print(f"recorded {len(current)} files in {manifest}")
        record_units(target, current)
        return
    saved = None
    if os.path.exists(manifest):
        saved = {}
        with open(manifest, encoding="utf-8", errors="surrogateescape") as f:
            for line in f:
                blob, _, path = line.rstrip("\n").partition(" ")
                saved[path] = blob
        drop_stale_units(target, current)
    elif os.path.isdir(target) and os.listdir(target):
        # A cached build saved without a manifest: nothing says which sources
        # it was built from, and the fixed time would make cargo reuse all of
        # it. Every file gets the current time, so every crate rebuilds.
        print(f"no manifest at {manifest} beside a cached build: rebuilding every crate")
        for path in current:
            if os.path.isfile(path) and not os.path.islink(path):
                os.utime(path, None)
        mark_start(target)
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
    mark_start(target)


if __name__ == "__main__":
    main()
