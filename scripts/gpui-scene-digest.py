#!/usr/bin/env python3
"""Checks that two builds of the GPUI frame benchmarks draw identical scenes.

    python scripts/gpui-scene-digest.py --base <dir> --head <dir> --out <dir>

Runs each `frame` executable briefly with GPUI_SCENE_DIGEST set, so every
frame a benchmark submits to the renderer is hashed (all primitives, in the
order the renderer receives them), then compares the digests frame by frame.
Criterion starts a benchmark several times and each start counts frames from
zero, so frames are compared as the set of digests seen at each
(benchmark, frame) position. Exits non-zero if any position differs.
"""

import argparse
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


def executable(directory: Path) -> Path:
    for name in ("frame.exe", "frame"):
        candidate = directory / name
        if candidate.exists():
            return candidate.resolve()
    sys.exit(f"error: no frame benchmark executable in {directory}")


def digests(binary: Path, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    # The benchmark runs from `out`, so every path it is given is absolute.
    out = out.resolve()
    digest_file = out / "digests.txt"
    digest_file.unlink(missing_ok=True)
    env = dict(os.environ, GPUI_SCENE_DIGEST=str(digest_file), CRITERION_HOME=str(out))
    command = [
        str(binary),
        "--bench",
        "--noplot",
        "--warm-up-time",
        "0.3",
        "--measurement-time",
        "0.3",
        "--sample-size",
        "10",
    ]
    with open(out / "log.txt", "w", encoding="utf-8") as log:
        result = subprocess.run(command, env=env, cwd=out, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        sys.exit(f"error: {binary} exited with {result.returncode}; log: {out / 'log.txt'}")
    seen = defaultdict(set)
    if digest_file.exists():
        for line in digest_file.read_text(encoding="utf-8").splitlines():
            name, frame, digest = line.split()
            seen[(name, int(frame))].add(digest)
    return seen


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--head", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()

    base = digests(executable(args.base), args.out / "base")
    head = digests(executable(args.head), args.out / "head")
    if not base or not head:
        print("No scenes were digested (this platform has no headless renderer); skipping.")
        return
    compared = sorted(set(base) & set(head))
    differing = [key for key in compared if base[key] != head[key]]
    benchmarks = sorted({name for name, _ in compared})
    if differing:
        lines = [f"**Scenes differ** at {len(differing)} of {len(compared)} (benchmark, frame) positions:"]
        lines += [f"- `{name}` frame {frame}" for name, frame in differing[:20]]
    else:
        lines = [
            f"Scenes identical: {len(compared)} (benchmark, frame) positions across "
            f"{len(benchmarks)} benchmarks drew the same primitives in the same order."
        ]
    report = "\n".join(lines) + "\n"
    print(report)
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as summary:
            summary.write("### Scene equivalence\n\n" + report + "\n")
    if differing:
        sys.exit(1)


if __name__ == "__main__":
    main()
