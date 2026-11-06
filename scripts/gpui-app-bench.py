#!/usr/bin/env python3
"""Interleaved A/B run of Cap's in-app editor timeline benchmark.

    python scripts/gpui-app-bench.py --base <cap-gpui> --head <cap-gpui> \
        --fixture <studio .cap> --out <dir> [--rounds 3] [--summary FILE]

Each run launches the real app on a fresh profile and a fresh copy of the
fixture project with CAP_GPUI_AUTO_TIMELINE_BENCH=1 (src/editor_bench.rs),
which times `Window::draw` across the editor's scenarios and exits. Base and
head alternate (base, head, head, base, ...) on the same machine; scenarios
are compared by the per-round ratio of median (p50) draw times, head / base.
The editor decodes video while it plays, so means and tails swing with the
decoder; the median is the stable statistic.
"""

import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

LINE = re.compile(
    r"^timeline-bench: (?P<label>\S+) (?P<mean>[\d.]+) mean / (?P<p50>[\d.]+) p50 / "
    r"(?P<p95>[\d.]+) p95 / (?P<max>[\d.]+) max us"
)

STORE = {
    "general_settings": {
        "hasCompletedOnboarding": True,
        "hasCompletedStartup": True,
        "enableNotifications": False,
        "enableTelemetry": False,
        "recordingCountdown": 0,
    },
    "recording_start_safety": {"confirmBeforeRecordingWithoutMicrophone": False},
}


def run(binary: Path, fixture: Path, log: Path, timeout: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="cap-app-bench-") as scratch:
        scratch = Path(scratch)
        profile = scratch / "profile"
        for sub in ("recordings", "logs"):
            (profile / sub).mkdir(parents=True)
        (profile / "store").write_text(json.dumps(STORE), encoding="utf-8")
        project = scratch / fixture.name
        shutil.copytree(fixture, project)
        env = dict(
            os.environ,
            CAP_GPUI_APP_DATA_DIR=str(profile),
            CAP_GPUI_RECORDINGS_DIR=str(profile / "recordings"),
            CAP_GPUI_LOG_DIR=str(profile / "logs"),
            CAP_GPUI_AUTO_NO_MIC="1",
            CAP_GPUI_AUTO_EDITOR=str(project),
            CAP_GPUI_AUTO_TIMELINE_BENCH="1",
            CAP_GPUI_NO_MENUS="1",
            CAP_GPUI_NO_TRAY="1",
            CAP_GPUI_MUTE_AUDIO="1",
        )
        with open(log, "w", encoding="utf-8") as output:
            try:
                result = subprocess.run(
                    [str(binary)],
                    env=env,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    timeout=timeout,
                )
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = "timeout"
    text = log.read_text(encoding="utf-8", errors="replace")
    scenarios = {}
    for line in text.splitlines():
        match = LINE.match(line.strip())
        if match:
            scenarios[match["label"]] = {
                key: float(match[key]) for key in ("mean", "p50", "p95", "max")
            }
    if code != 0 or not scenarios:
        sys.stdout.write(text[-6000:])
        sys.exit(f"error: {binary} exited with {code} and reported {len(scenarios)} scenarios")
    return scenarios


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--head", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--label", default="")
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    binaries = {"base": args.base, "head": args.head}
    samples = {"base": [], "head": []}
    for round_ix in range(args.rounds):
        order = ["base", "head"] if round_ix % 2 == 0 else ["head", "base"]
        for side in order:
            print(f"round {round_ix + 1}/{args.rounds}: {side}", flush=True)
            log = args.out / f"{side}-round-{round_ix}.log"
            samples[side].append(run(binaries[side], args.fixture, log, args.timeout))

    labels = [label for label in samples["base"][0] if label in samples["head"][0]]
    rows = []
    for label in labels:
        ratios = {}
        for stat in ("mean", "p50", "p95"):
            ratios[stat] = [
                h[label][stat] / b[label][stat]
                for b, h in zip(samples["base"], samples["head"])
                if b[label][stat] > 0
            ]
        rows.append(
            {
                "scenario": label,
                "base_mean_us": statistics.median(s[label]["mean"] for s in samples["base"]),
                "head_mean_us": statistics.median(s[label]["mean"] for s in samples["head"]),
                "base_p95_us": statistics.median(s[label]["p95"] for s in samples["base"]),
                "head_p95_us": statistics.median(s[label]["p95"] for s in samples["head"]),
                "base_p50_us": statistics.median(s[label]["p50"] for s in samples["base"]),
                "head_p50_us": statistics.median(s[label]["p50"] for s in samples["head"]),
                "p50_ratio": statistics.median(ratios["p50"]),
                "p50_ratio_range": [min(ratios["p50"]), max(ratios["p50"])],
                "mean_ratio": statistics.median(ratios["mean"]),
                "p95_ratio": statistics.median(ratios["p95"]),
            }
        )
    (args.out / "comparison.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")

    title = f"Cap editor draw benchmark{f' ({args.label})' if args.label else ''}"
    lines = [
        f"### {title}",
        "",
        f"`Window::draw` in the real editor (src/editor_bench.rs), {args.rounds} interleaved "
        "rounds; head/base ratio of each round's median draw, paired by round. "
        "**faster**/**slower** only when every round agrees.",
        "",
        "| Scenario | Base p50 | Head p50 | Change | Round range | Mean change | p95 change | |",
        "|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        low, high = row["p50_ratio_range"]
        verdict = "**faster**" if high < 1 else "**slower**" if low > 1 else ""
        lines.append(
            f"| `{row['scenario']}` | {row['base_p50_us']:.1f} µs | {row['head_p50_us']:.1f} µs "
            f"| {(row['p50_ratio'] - 1) * 100:+.1f}% | {(low - 1) * 100:+.1f}% … {(high - 1) * 100:+.1f}% "
            f"| {(row['mean_ratio'] - 1) * 100:+.1f}% | {(row['p95_ratio'] - 1) * 100:+.1f}% | {verdict} |"
        )
    report = "\n".join(lines) + "\n"
    print(report)
    (args.out / "comparison.md").write_text(report, encoding="utf-8")
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as summary:
            summary.write(report + "\n")


if __name__ == "__main__":
    main()
