#!/usr/bin/env python3
"""Paired performance comparison of two builds of the engine suite binaries.

Runs each workload alternately with the base and head binaries on the same
machine and compares the medians of the test process's CPU time (user +
system, from the kernel's rusage) and wall time. CPU time ignores scheduling
noise better than wall time; pairing cancels most of the machine's state.

    perf-ab.py --base base.json --head head.json --fixtures DIR --out DIR

base.json / head.json map a test target ("export", "seek") to its binary and
the crate directory to run it from:
    {"worktree": "...", "binaries": {"export": "...", "seek": "..."}}
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

# A head build is slower when the median of its per-pair CPU ratios to the
# base exceeds the workload's limit and it is slower in most pairs. Adjacent
# runs of a pair share the machine's state; across a job a Blacksmith VM's
# speed drifts (one seek-storm job ran 10.1 to 13.2 s per run for the same
# code). Limits sit above the median-ratio noise of identical code on
# blacksmith-6vcpu-macos-26 (runs 38995088761, 38998485953): export-basic
# 1.1%, export-jitter-camera-40s 4.4%, seek-storm 5.0%. Real-time playback's
# CPU varied by 15%, so it is reported without a limit.
WORKLOADS = [
    ("export-basic", "export", "export/basic/*", "fast", 0.05),
    ("export-jitter-camera-40s", "export", "export/jitter-camera-40s/*", "fast", 0.10),
    ("seek-storm", "seek", "seek/*/storm30/*", "fast", 0.10),
    ("playback-basic", "playback", "playback/basic/*", "fast", None),
]

WALL_WARN = 0.08


def run_once(side, target, case, tier, fixtures, report):
    binary = side["binaries"][target]
    env = dict(
        os.environ,
        CAP_VERIFY_FIXTURE_DIR=str(fixtures),
        CAP_VERIFY_REPORT_DIR=str(report),
        CAP_VERIFY_CASE=case,
        CAP_VERIFY_TIER=tier,
    )
    report.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with (report / "test.log").open("w") as log:
        process = subprocess.Popen(
            [binary, "--test-threads", "1", "--nocapture"],
            cwd=Path(side["worktree"]) / "crates/verify",
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        _, status, usage = os.wait4(process.pid, 0)
    wall = time.monotonic() - started
    outcomes = {}
    for path in report.glob("cap-verify-*.jsonl"):
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("case"):
                outcomes[row["case"]] = row.get("outcome")
    return {
        "cpu": usage.ru_utime + usage.ru_stime,
        "wall": wall,
        "exit": os.waitstatus_to_exitcode(status),
        "outcomes": outcomes,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--pairs", type=int, default=3)
    parser.add_argument("--summary")
    args = parser.parse_args()

    sides = {
        "base": json.loads(Path(args.base).read_text()),
        "head": json.loads(Path(args.head).read_text()),
    }
    fixtures = Path(args.fixtures)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rows = []
    failed = []
    broken = []

    def check(name, label, result, report):
        # A test binary exits 0, or 101 when a case fails. Anything else (a
        # signal, a missing library) means nothing was measured.
        if result["exit"] in (0, 101) and result["outcomes"]:
            return True
        log = report / "test.log"
        tail = log.read_text(errors="replace").splitlines()[-15:] if log.exists() else []
        print(f"::error::{name} {label}: exit {result['exit']}, {len(result['outcomes'])} cases reported")
        print("\n".join(tail))
        return False
    for name, target, case, tier, cpu_limit in WORKLOADS:
        # The first run of a side generates fixtures and fills caches.
        usable = True
        for label, side in sides.items():
            report = out / name / f"warm-{label}"
            usable &= check(name, label, run_once(side, target, case, tier, fixtures, report), report)
        if not usable:
            rows.append((name, None, None, None, None, "BROKEN: a test binary did not run its cases", None))
            broken.append(name)
            continue
        samples = {"base": [], "head": []}
        for pair in range(args.pairs):
            order = ("base", "head") if pair % 2 == 0 else ("head", "base")
            for label in order:
                report = out / name / f"{pair}-{label}"
                result = run_once(sides[label], target, case, tier, fixtures, report)
                if not check(name, label, result, report):
                    broken.append(name)
                samples[label].append(result)
                print(
                    f"{name} pair {pair} {label}: cpu {result['cpu']:.2f}s wall {result['wall']:.2f}s exit {result['exit']}",
                    flush=True,
                )
        if name in broken:
            rows.append((name, None, None, None, None, "BROKEN: a test binary did not run its cases", None))
            continue
        outcomes = [s["outcomes"] for runs in samples.values() for s in runs]
        if any(o != outcomes[0] for o in outcomes):
            # Correctness is the suite's job; a case that now passes or fails
            # can change how much work runs, so its time is not comparable.
            rows.append((name, None, None, None, None, "case outcomes differ between runs: timing not compared", None))
            continue
        cpu = {label: statistics.median(s["cpu"] for s in runs) for label, runs in samples.items()}
        wall = {label: statistics.median(s["wall"] for s in runs) for label, runs in samples.items()}
        cpu_delta = statistics.median(
            h["cpu"] / b["cpu"] for b, h in zip(samples["base"], samples["head"])
        ) - 1
        wall_delta = wall["head"] / wall["base"] - 1
        slower_pairs = sum(
            h["cpu"] > b["cpu"] for b, h in zip(samples["base"], samples["head"])
        )
        verdict = "ok" if cpu_limit is not None else "reported only"
        if cpu_limit is not None and cpu_delta > cpu_limit and slower_pairs * 4 >= args.pairs * 3:
            verdict = f"SLOWER: CPU +{cpu_delta:.1%}, slower in {slower_pairs} of {args.pairs} pairs"
            failed.append(name)
        elif wall_delta > WALL_WARN:
            verdict = f"wall +{wall_delta:.1%} (warning only)"
        rows.append((name, cpu["base"], cpu["head"], wall["base"], wall["head"], verdict, cpu_delta))

    lines = [
        "## Perf budget",
        "",
        f"{args.pairs} interleaved pairs: median test process CPU time (user + system) and wall time per side, and the median of the per-pair CPU ratios.",
        "",
        "| Workload | CPU base | CPU head | CPU change (median of pairs) | Wall base | Wall head | Wall change | Verdict |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, cb, ch, wb, wh, verdict, cpu_delta in rows:
        if cb is None:
            lines.append(f"| {name} | | | | | | | {verdict} |")
        else:
            lines.append(
                f"| {name} | {cb:.2f} s | {ch:.2f} s | {cpu_delta:+.1%} | {wb:.2f} s | {wh:.2f} s | {wh / wb - 1:+.1%} | {verdict} |"
            )
    text = "\n".join(lines) + "\n"
    print(text)
    (out / "perf-budget.md").write_text(text)
    if args.summary:
        with open(args.summary, "a") as summary:
            summary.write(text)
    if broken:
        print(f"::error::not measured: {', '.join(sorted(set(broken)))}")
    if failed:
        print(f"::error::slower than the base build: {', '.join(failed)}")
    return 1 if broken or failed else 0


if __name__ == "__main__":
    sys.exit(main())
