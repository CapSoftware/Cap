#!/usr/bin/env python3
"""Interleaved A/B run of two builds of Cap's GPUI frame benchmarks.

    python scripts/gpui-bench-compare.py --base <dir> --head <dir> --out <dir>
        [--rounds 5] [--measurement-time 2] [--sample-size 20] [--filter REGEX]
        [--summary FILE]

<dir> holds the `frame` (or `frame.exe`) executable built by
scripts/gpui-bench-build.sh. Both executables run on the same machine in
alternating order (base, head, head, base, ...) so drift in machine state lands
on both sides. Every run writes Criterion's estimates under its own
CRITERION_HOME; each benchmark is compared by the per-round ratio of Criterion
median times (head / base), paired by round.
"""

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from pathlib import Path


def executable(directory: Path) -> Path:
    for name in ("frame.exe", "frame"):
        candidate = directory / name
        if candidate.exists():
            # Each run executes from its own CRITERION_HOME.
            return candidate.resolve()
    sys.exit(f"error: no frame benchmark executable in {directory}")


def run(binary: Path, home: Path, args: argparse.Namespace, log: Path) -> dict:
    home.mkdir(parents=True, exist_ok=True)
    command = [
        str(binary),
        "--bench",
        "--noplot",
        "--warm-up-time",
        str(args.warm_up_time),
        "--measurement-time",
        str(args.measurement_time),
        "--sample-size",
        str(args.sample_size),
    ]
    if args.filter:
        command.append(args.filter)
    env = dict(os.environ, CRITERION_HOME=str(home))
    with open(log, "w", encoding="utf-8") as output:
        result = subprocess.run(
            command, env=env, stdout=output, stderr=subprocess.STDOUT, cwd=home
        )
    if result.returncode != 0:
        sys.stdout.write(log.read_text(encoding="utf-8", errors="replace")[-8000:])
        sys.exit(f"error: {binary} exited with {result.returncode}; log: {log}")
    estimates = {}
    for benchmark_json in home.rglob("new/benchmark.json"):
        full_id = json.loads(benchmark_json.read_text(encoding="utf-8"))["full_id"]
        data = json.loads(
            (benchmark_json.parent / "estimates.json").read_text(encoding="utf-8")
        )
        estimates[full_id] = data["median"]["point_estimate"]
    if not estimates:
        sys.exit(f"error: {binary} wrote no Criterion estimates under {home}")
    return estimates, draw_means(log)


REPORT = re.compile(r"^GPUI bench report \(all observed iterations\): (\S+)$")


def draw_means(log: Path) -> dict:
    """Mean `Window::draw` time per benchmark report, in nanoseconds.

    Criterion times a whole iteration, which on macOS includes waiting for the
    headless GPU to hand back an instance buffer; light frames end up bound by
    the GPU. The bench report's `window draw` histogram is the CPU cost of the
    frame alone. Reports cover every input of a benchmark group together.
    """
    means = {}
    name = None
    in_draw = False
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        match = REPORT.match(line)
        if match:
            name, in_draw = match[1], False
        elif name and line == "window draw:":
            in_draw = True
        elif name and in_draw and line.startswith("mean:"):
            value = line.split(":", 1)[1].strip()
            scale = {"ms": 1e6, "µs": 1e3, "us": 1e3, "ns": 1.0, "s": 1e9}
            for unit in ("ms", "µs", "us", "ns", "s"):
                if value.endswith(unit):
                    means[name] = float(value[: -len(unit)]) * scale[unit]
                    break
            name, in_draw = None, False
    return means


def format_time(nanos: float) -> str:
    if nanos >= 1e6:
        return f"{nanos / 1e6:.2f} ms"
    if nanos >= 1e3:
        return f"{nanos / 1e3:.1f} µs"
    return f"{nanos:.0f} ns"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--head", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--warm-up-time", type=float, default=1.0)
    parser.add_argument("--measurement-time", type=float, default=2.0)
    # Criterion's default of 100 linearly growing samples runs a 10 ms frame
    # 5 050 times per benchmark regardless of --measurement-time; 20 samples
    # keep a round to about a minute while the paired rounds carry the
    # statistics.
    parser.add_argument("--sample-size", type=int, default=20)
    parser.add_argument("--filter", default="")
    parser.add_argument("--label", default="")
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()

    binaries = {"base": executable(args.base), "head": executable(args.head)}
    samples = {"base": [], "head": []}
    draws = {"base": [], "head": []}
    args.out.mkdir(parents=True, exist_ok=True)
    for round_ix in range(args.rounds):
        order = ["base", "head"] if round_ix % 2 == 0 else ["head", "base"]
        for side in order:
            home = args.out / side / f"round-{round_ix}"
            log = args.out / f"{side}-round-{round_ix}.log"
            print(f"round {round_ix + 1}/{args.rounds}: {side}", flush=True)
            estimates, draw = run(binaries[side], home, args, log)
            samples[side].append(estimates)
            draws[side].append(draw)

    names = sorted(set(samples["base"][0]) & set(samples["head"][0]))
    rows = []
    for name in names:
        base = [estimates[name] for estimates in samples["base"]]
        head = [estimates[name] for estimates in samples["head"]]
        ratios = [h / b for b, h in zip(base, head)]
        median_ratio = statistics.median(ratios)
        if max(ratios) < 1.0:
            verdict = "faster"
        elif min(ratios) > 1.0:
            verdict = "slower"
        else:
            verdict = "~"
        rows.append(
            {
                "benchmark": name,
                "base_ns": statistics.median(base),
                "head_ns": statistics.median(head),
                "median_ratio": median_ratio,
                "min_ratio": min(ratios),
                "max_ratio": max(ratios),
                "verdict": verdict,
                "base_samples": base,
                "head_samples": head,
            }
        )

    (args.out / "comparison.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    title = f"GPUI frame benchmarks{f' ({args.label})' if args.label else ''}"
    lines = [
        f"### {title}",
        "",
        f"{args.rounds} interleaved rounds; Criterion median per round, head/base paired by round. "
        "**faster**/**slower** only when every round agrees.",
        "",
        "| Benchmark | Base | Head | Change | Round range | |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        change = (row["median_ratio"] - 1.0) * 100.0
        spread = f"{(row['min_ratio'] - 1) * 100:+.1f}% … {(row['max_ratio'] - 1) * 100:+.1f}%"
        verdict = {"faster": "**faster**", "slower": "**slower**"}.get(row["verdict"], "")
        lines.append(
            f"| `{row['benchmark']}` | {format_time(row['base_ns'])} | {format_time(row['head_ns'])} "
            f"| {change:+.1f}% | {spread} | {verdict} |"
        )
    draw_names = sorted(set(draws["base"][0]) & set(draws["head"][0]))
    if draw_names:
        lines += [
            "",
            "`Window::draw` alone (CPU cost of a frame, from GPUI's bench report; "
            "grouped benchmarks report all their inputs together):",
            "",
            "| Benchmark | Base | Head | Change | Round range | |",
            "|---|---:|---:|---:|---:|---|",
        ]
        for name in draw_names:
            base = [d[name] for d in draws["base"] if name in d]
            head = [d[name] for d in draws["head"] if name in d]
            ratios = [h / b for b, h in zip(base, head) if b > 0]
            if not ratios:
                continue
            ratio = statistics.median(ratios)
            verdict = (
                "**faster**" if max(ratios) < 1 else "**slower**" if min(ratios) > 1 else ""
            )
            lines.append(
                f"| `{name}` | {format_time(statistics.median(base))} "
                f"| {format_time(statistics.median(head))} | {(ratio - 1) * 100:+.1f}% "
                f"| {(min(ratios) - 1) * 100:+.1f}% … {(max(ratios) - 1) * 100:+.1f}% | {verdict} |"
            )
    report = "\n".join(lines) + "\n"
    print(report)
    (args.out / "comparison.md").write_text(report, encoding="utf-8")
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as summary:
            summary.write(report + "\n")


if __name__ == "__main__":
    main()
