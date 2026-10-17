#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import os
import pathlib
import platform
import random
import re
import statistics
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parents[1]
BASE = "db7ecfcf205446de4e9d4192deed698a4175450f"
MASK = "crates/rendering/src/mask.rs"


def cpu_name():
    if platform.system() == "Darwin":
        return subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
        ).strip()
    return platform.processor() or platform.machine()


def memory_bytes():
    if platform.system() == "Darwin":
        return int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]))
    if hasattr(os, "sysconf"):
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    return None


def load_average():
    return os.getloadavg() if hasattr(os, "getloadavg") else None


def git_source(base, path):
    return subprocess.check_output(
        ["git", "show", f"{base}:{path}"], cwd=REPO, text=True
    )


def definition(source, kind, name):
    start = source.index(f"pub {kind} {name}")
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return re.sub(r"\s*#\[serde\([^\n]*\)\]\n", "\n", source[start:end])


def summarize(rows):
    output = []
    rng = random.Random(182904)
    for case in dict.fromkeys(row["case"] for row in rows):
        selected = [row for row in rows if row["case"] == case]
        old = [float(row["baseline_ns"]) for row in selected]
        new = [float(row["candidate_ns"]) for row in selected]
        ratios = [a / b for a, b in zip(old, new)]
        boot = sorted(
            statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(2000)
        )
        process_medians = {
            process: statistics.median(
                float(row["baseline_ns"]) / float(row["candidate_ns"])
                for row in selected
                if row["process"] == process
            )
            for process in dict.fromkeys(row["process"] for row in selected)
        }
        output.append(
            {
                "case": case,
                "total_masks": int(selected[0]["total"]),
                "active_masks": int(selected[0]["active"]),
                "paired_samples": len(selected),
                "baseline_median_ns": statistics.median(old),
                "candidate_median_ns": statistics.median(new),
                "paired_saved_median_ns": statistics.median(
                    a - b for a, b in zip(old, new)
                ),
                "paired_speedup_median": statistics.median(ratios),
                "paired_speedup_q10": sorted(ratios)[int(len(ratios) * 0.1)],
                "paired_speedup_q90": sorted(ratios)[int(len(ratios) * 0.9)],
                "conditional_bootstrap_median_95pct": [boot[50], boot[1949]],
                "process_speedup_medians": process_medians,
                "minimum_side_elapsed_ms": min(
                    min(
                        float(row["baseline_elapsed_ns"]),
                        float(row["candidate_elapsed_ns"]),
                    )
                    / 1_000_000
                    for row in selected
                ),
            }
        )
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-only", action="store_true")
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--run-id", default="final")
    parser.add_argument("--processes", type=int, default=3)
    parser.add_argument("--samples", type=int, default=24)
    parser.add_argument("--sample-ms", type=int, default=30)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.run_id):
        parser.error("Use letters, digits, underscores, or hyphens for --run-id.")
    if args.processes < 1 or args.samples < 4 or args.sample_ms < 10:
        parser.error("Use at least one process, four samples, and 10 ms per sample.")
    result_dir = REPO / "target" / "active-mask-benchmark" / args.run_id
    if result_dir.exists():
        parser.error("Use a new --run-id to preserve previous results.")
    output = result_dir / "generated"
    output.mkdir(parents=True)
    base = subprocess.check_output(
        ["git", "rev-parse", args.base], cwd=REPO, text=True
    ).strip()
    baseline = git_source(base, MASK)
    candidate = (REPO / MASK).read_text()
    (output / "baseline.rs").write_text(baseline)
    (output / "candidate.rs").write_text(candidate)
    config = git_source(base, "crates/project/src/configuration.rs")
    rendering = git_source(base, "crates/rendering/src/lib.rs")
    types = ["extern crate self as cap_project;"]
    for name in ["XY", "MaskScalarKeyframe", "MaskVectorKeyframe", "MaskKeyframes"]:
        types.extend(
            [
                "#[derive(Clone, Copy, Debug)]"
                if name == "XY"
                else "#[derive(Clone, Debug, Default)]",
                definition(config, "struct", name),
            ]
        )
    types.extend(
        ["impl<T> XY<T> { pub const fn new(x: T, y: T) -> Self { Self { x, y } } }"]
    )
    for name in ["MaskSegment", "MaskEffectContract"]:
        types.extend(["#[derive(Clone, Debug)]", definition(config, "struct", name)])
    types.extend(
        ["#[derive(Clone, Copy, Debug)]", definition(config, "enum", "MaskKind")]
    )
    types.extend(
        [
            "#[derive(Clone, Copy, Debug, PartialEq, Eq)]",
            definition(rendering, "enum", "MaskRenderMode"),
        ]
    )
    types.extend(
        ["#[derive(Clone, Debug)]", definition(rendering, "struct", "PreparedMask")]
    )
    effects = json.loads(git_source(base, "crates/project/mask-effects.json"))
    fields = {
        "blur_encoding_offset": effects["blurEncodingOffset"],
        "default_amount": effects["defaultAmount"],
        "min_amount": effects["minAmount"],
        "max_amount": effects["maxAmount"],
    }
    types.append(
        "pub fn mask_effect_contract() -> &'static MaskEffectContract { &MaskEffectContract { "
        + ", ".join(f"{k}: {float(v)}" for k, v in fields.items())
        + " } }"
    )
    types.extend(
        [
            'mod baseline { include!("baseline.rs"); }',
            'mod control { include!("baseline.rs"); }',
            'mod candidate { include!("candidate.rs"); }',
            f"include!({json.dumps(str(ROOT / 'mask_bench.rs'))});",
        ]
    )
    harness = output / "harness.rs"
    harness.write_text("\n".join(types) + "\n")
    manifest = {
        "base_revision": base,
        "mask_path": MASK,
        "baseline_sha256": hashlib.sha256(baseline.encode()).hexdigest(),
        "candidate_sha256": hashlib.sha256(candidate.encode()).hexdigest(),
        "harness_sha256": hashlib.sha256(harness.read_bytes()).hexdigest(),
        "benchmark_sha256": hashlib.sha256(
            (ROOT / "mask_bench.rs").read_bytes()
        ).hexdigest(),
        "candidate_worktree_head": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
        ).strip(),
        "rustc": subprocess.check_output(["rustc", "-vV"], text=True).strip(),
        "platform": platform.platform(),
        "cpu": cpu_name(),
        "memory_bytes": memory_bytes(),
        "load_before": load_average(),
        "parameters": vars(args),
        "observed_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "Exact production mask modules and pinned type fields. Serialization derives omitted. Release optimization, ABBA order, separate side calibration, identical-code controls.",
        "limits": "Synthetic CPU mask preparation only. No GPUI, GPU rendering, decode, encode, or end-to-end timing. Conditional bootstrap intervals describe this host and sample set.",
    }
    (result_dir / "source-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    common = [
        "rustc",
        "--edition=2024",
        "-C",
        "opt-level=3",
        "-D",
        "warnings",
        str(harness),
    ]
    subprocess.run(common + ["--test", "-o", str(output / "mask-tests")], check=True)
    with (result_dir / "correctness.log").open("w") as log:
        subprocess.run([str(output / "mask-tests")], stdout=log, stderr=log, check=True)
    print((result_dir / "correctness.log").read_text(), flush=True)
    if args.test_only:
        return
    subprocess.run(common + ["-o", str(output / "mask-bench")], check=True)
    rows = []
    for process in range(args.processes):
        command = [
            str(output / "mask-bench"),
            str(args.samples),
            str(args.sample_ms),
            str(process),
        ]
        with (result_dir / f"samples-{process}.csv").open("w") as raw:
            subprocess.run(command, stdout=raw, check=True)
        with (result_dir / f"samples-{process}.csv").open() as raw:
            rows.extend(dict(row, process=str(process)) for row in csv.DictReader(raw))
        print(f"Complete process {process + 1}/{args.processes}.", flush=True)
    summaries = summarize(rows)
    for summary in summaries:
        print(json.dumps(summary))
    (result_dir / "summary.json").write_text(json.dumps(summaries, indent=2) + "\n")
    manifest["load_after"] = load_average()
    (result_dir / "source-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
