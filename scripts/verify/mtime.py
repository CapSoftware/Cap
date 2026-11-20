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

A run builds only the crates its suites need, but the cache it saves still
holds every crate earlier runs built, some with other feature sets. Before
recording, a cached crate this run did not rebuild loses its cargo fingerprint
when any of its sources changed since the restored manifest, so the next run
that needs it rebuilds it instead of trusting the recorded blob ids.
"""

import os
import shutil
import subprocess
import sys

OLD = 946684800  # 2000-01-01
HEADER = "# mtime manifest v2"


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


def load(manifest):
    """The blob ids a trusted manifest records, or None. Manifests written
    before stale crates were dropped (no header) are not trusted."""
    if not os.path.exists(manifest):
        return None
    with open(manifest, encoding="utf-8", errors="surrogateescape") as f:
        lines = f.read().split("\n")
    if not lines or lines[0] != HEADER:
        return None
    saved = {}
    for line in lines[1:]:
        if line:
            blob, _, path = line.partition(" ")
            saved[path] = blob
    return saved


def dep_info_paths(dep_file, root):
    """Repository-relative paths of the sources a rustc dep-info file lists."""
    with open(dep_file, encoding="utf-8", errors="surrogateescape") as f:
        text = f.read()
    paths = []
    for line in text.splitlines():
        if line.endswith(":") and ": " not in line:
            entries = [line[:-1]]
        elif ": " in line:
            entries = []
            current = ""
            rest = line.split(": ", 1)[1]
            i = 0
            while i < len(rest):
                if rest[i] == "\\" and i + 1 < len(rest) and rest[i + 1] == " ":
                    current += " "
                    i += 2
                    continue
                if rest[i] == " ":
                    if current:
                        entries.append(current)
                    current = ""
                else:
                    current += rest[i]
                i += 1
            if current:
                entries.append(current)
        else:
            continue
        for entry in entries:
            full = os.path.normpath(os.path.join(root, entry))
            try:
                relative = os.path.relpath(full, root)
            except ValueError:
                # Another drive on Windows: never a workspace file.
                continue
            if not relative.startswith(".."):
                paths.append(relative.replace(os.sep, "/"))
    return paths


def package_dirs(current):
    """Directory of every workspace package, keyed by package name."""
    dirs = {}
    for path in current:
        if os.path.basename(path) != "Cargo.toml" or not os.path.isfile(path):
            continue
        section = None
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            for line in f:
                line = line.strip()
                if line.startswith("["):
                    section = line
                elif section == "[package]" and line.startswith("name") and "=" in line:
                    name = line.split("=", 1)[1].strip().strip('"').strip("'")
                    dirs[name] = os.path.dirname(path)
                    break
    return dirs


def build_script_inputs(output_file, package_dir):
    """Repository-relative paths a build script run watches: its
    rerun-if-changed paths, or its whole package when it names none."""
    watched = []
    with open(output_file, encoding="utf-8", errors="surrogateescape") as f:
        for line in f:
            for prefix in ("cargo::rerun-if-changed=", "cargo:rerun-if-changed="):
                if line.startswith(prefix):
                    watched.append(line[len(prefix) :].rstrip("\r\n"))
    root = os.getcwd()
    paths = []
    for entry in watched or ["."]:
        full = os.path.normpath(os.path.join(root, package_dir, entry))
        try:
            relative = os.path.relpath(full, root)
        except ValueError:
            continue
        if not relative.startswith(".."):
            paths.append("" if relative == "." else relative.replace(os.sep, "/"))
    return paths


def touches(paths, changed):
    for path in paths:
        if path in changed:
            return True
        prefix = path.rstrip("/") + "/" if path else ""
        if any(item.startswith(prefix) for item in changed):
            return True
    return False


def drop_fingerprint(profile, suffix):
    fingerprints = os.path.join(profile, ".fingerprint")
    if os.path.isdir(fingerprints):
        for fingerprint in os.listdir(fingerprints):
            if fingerprint.endswith(suffix):
                shutil.rmtree(os.path.join(fingerprints, fingerprint))


def drop_stale_crates(target, changed, applied_at, packages):
    """Removes the fingerprint of every cached crate, build script or build
    script run this run did not redo whose inputs changed, so cargo redoes it
    the next time it is needed."""
    root = os.getcwd()
    dropped = 0
    for directory, subdirectories, files in os.walk(target):
        parent = os.path.dirname(directory)
        if os.path.basename(directory) == "deps":
            profile = parent
        elif os.path.basename(parent) == "build":
            profile = os.path.dirname(parent)
        else:
            continue
        subdirectories[:] = []
        if profile != parent and "output" in files:
            output = os.path.join(directory, "output")
            package, _, unit = os.path.basename(directory).rpartition("-")
            if (
                os.path.getmtime(output) < applied_at
                and package in packages
                and touches(build_script_inputs(output, packages[package]), changed)
            ):
                drop_fingerprint(profile, "-" + unit)
                os.remove(output)
                dropped += 1
        for name in files:
            if not name.endswith(".d") or "-" not in name:
                continue
            dep_file = os.path.join(directory, name)
            if os.path.getmtime(dep_file) >= applied_at:
                continue
            if not any(path in changed for path in dep_info_paths(dep_file, root)):
                continue
            drop_fingerprint(profile, "-" + name[: -len(".d")].rsplit("-", 1)[1])
            os.remove(dep_file)
            dropped += 1
    return dropped


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("record", "apply"):
        sys.exit(__doc__)
    command, manifest = sys.argv[1], sys.argv[2]
    current = blobs()
    stamp = manifest + ".applied"
    if command == "record":
        target = os.path.dirname(os.path.abspath(manifest))
        os.makedirs(target, exist_ok=True)
        if os.path.exists(stamp):
            previous = load(manifest)
            changed = {
                path
                for path, blob in current.items()
                if previous is None or previous.get(path) != blob
            }
            dropped = drop_stale_crates(
                target, changed, os.path.getmtime(stamp), package_dirs(current)
            )
            header = HEADER
            print(f"dropped {dropped} cached crates built from changed sources")
        else:
            # Without the time of the apply step, crates rebuilt by this run
            # cannot be told from stale ones: save a manifest the next run
            # does not trust.
            header = None
            print("no apply stamp: the next run will not trust this manifest")
        with open(manifest, "w", encoding="utf-8", errors="surrogateescape") as f:
            if header:
                f.write(header + "\n")
            for path, blob in sorted(current.items()):
                f.write(f"{blob} {path}\n")
        print(f"recorded {len(current)} files in {manifest}")
        return
    try:
        apply(manifest, current)
    finally:
        os.makedirs(os.path.dirname(os.path.abspath(stamp)), exist_ok=True)
        with open(stamp, "w", encoding="utf-8"):
            pass


def apply(manifest, current):
    saved = load(manifest)
    target = os.path.dirname(manifest)
    if saved is None and os.path.isdir(target) and os.listdir(target):
        # A cached build saved without a trusted manifest: nothing says which
        # sources it was built from, and the fixed time would make cargo reuse
        # all of it. Every file gets the current time, so every crate rebuilds.
        print(f"no trusted manifest at {manifest} beside a cached build: rebuilding every crate")
        for path in current:
            if os.path.isfile(path) and not os.path.islink(path):
                os.utime(path, None)
        return
    if saved is None:
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
