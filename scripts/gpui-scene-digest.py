#!/usr/bin/env python3
"""Usage: gpui-scene-digest.py --base <dir> --head <dir> --out <dir>

Criterion restarts each benchmark several times with the frame counter at zero,
so frames are compared as the set of digests per (benchmark, frame) position,
and only over the frames both builds reached: in Criterion's fixed time a
faster build draws more of them.
"""

import argparse
import os
import subprocess
import platform
import sys
from collections import defaultdict
from pathlib import Path

# Frames every benchmark must submit on both sides; well under what a 1 s
# warm-up draws even for the slowest benchmark.
MIN_FRAMES = 16


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
        "1",
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
    if not base and not head and platform.system() != "Darwin":
        # Only macOS provides a headless renderer for benchmark windows, so
        # elsewhere no frame reaches a renderer that could be observed.
        print("No headless renderer on this platform; scene equivalence not checked.")
        return
    if not base or not head:
        empty = "base" if not base else "head"
        report = f"**No scenes were digested by {empty}**; the headless renderer did not start.\n"
        finish(args, report, failed=True)

    def frames(seen: dict) -> dict:
        reached = defaultdict(int)
        for name, frame in seen:
            reached[name] = max(reached[name], frame + 1)
        return reached

    base_frames, head_frames = frames(base), frames(head)
    benchmarks = sorted(set(base_frames) | set(head_frames))
    short = [
        (name, base_frames.get(name, 0), head_frames.get(name, 0))
        for name in benchmarks
        if min(base_frames.get(name, 0), head_frames.get(name, 0)) < MIN_FRAMES
    ]
    compared = [
        (name, frame)
        for name in benchmarks
        for frame in range(min(base_frames.get(name, 0), head_frames.get(name, 0)))
    ]
    missing = [key for key in compared if key not in base or key not in head]
    differing = [key for key in compared if key in base and key in head and base[key] != head[key]]
    failed = bool(short or missing or differing)
    if failed:
        lines = []
        if short:
            lines.append(f"**Too few frames** (need {MIN_FRAMES} on each side):")
            lines += [f"- `{name}`: base {b}, head {h}" for name, b, h in short]
        if missing:
            lines.append(f"**Frames missing** on one side at {len(missing)} positions:")
            lines += [f"- `{name}` frame {frame}" for name, frame in missing[:20]]
        if differing:
            lines.append(
                f"**Scenes differ** at {len(differing)} of {len(compared)} (benchmark, frame) positions:"
            )
            lines += [f"- `{name}` frame {frame}" for name, frame in differing[:20]]
    else:
        lines = [
            f"Scenes identical: {len(compared)} (benchmark, frame) positions across "
            f"{len(benchmarks)} benchmarks drew the same primitives, in the same order, "
            "showing the same atlas pixels."
        ]
    report = "\n".join(lines) + "\n"
    finish(args, report, failed=failed)


def finish(args: argparse.Namespace, report: str, failed: bool) -> None:
    print(report)
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as summary:
            summary.write("### Scene equivalence\n\n" + report + "\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
