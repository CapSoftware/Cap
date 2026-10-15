#!/usr/bin/env python3
"""Runs catalogue mutations one at a time against the cap-verify suites.

  run.py --platform linux --ids "T01 T02" --out DIR [--suites a,b] [--baseline-runs N]
         [--fresh-fixtures]

1. builds the suites the given mutations need and runs them unmutated
   (baseline; failures there are excluded from verdicts),
2. for each mutation: applies it, rebuilds, runs its suites, records which
   cases/tests fail that passed in the baseline, reverts.

Writes DIR/results.jsonl (one line per mutation) and DIR/<id>/... reports.
A mutation is CAUGHT when any suite exits non-zero with a failure that the
baseline did not have, MISSED when every suite behaves as in the baseline.
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
from mutations import M  # noqa: E402

BY_ID = {m["id"]: m for m in M}
PROFILE = os.environ.get("CAP_VERIFY_CARGO_PROFILE", "ci-verify")
GPUI_TOOLCHAIN = os.environ.get("GPUI_TOOLCHAIN", "+1.95.0")
SUITE_TIMEOUT = int(os.environ.get("MUTATION_SUITE_TIMEOUT", "1800"))


def suite_commands(suite, platform):
    """(build argv, run argv, cwd) for a suite."""
    cargo = ["cargo", "test", "--profile", PROFILE]
    if suite in ("export", "playback", "seek", "audio", "captions", "editing", "codec", "recording"):
        sel = ["-p", "cap-verify", "--test", suite]
        return cargo + sel + ["--no-run"], cargo + sel, ROOT
    if suite == "dm":
        sel = ["-p", "cap-rendering", "--lib"]
        filt = (
            ["decoder::model::"]
            if platform == "macos"
            else ["decoder::model::ffmpeg_answers_match_the_reference_model"]
        )
        return cargo + sel + ["--no-run"], cargo + sel + ["--"] + filt, ROOT
    if suite == "gpui":
        base = ["cargo", GPUI_TOOLCHAIN, "test", "--manifest-path", "apps/desktop-gpui/Cargo.toml", "--bin", "cap-gpui"]
        if os.environ.get("GPUI_TARGET"):
            base += ["--target", os.environ["GPUI_TARGET"]]
        return base + ["--no-run"], base + ["--", "verify_tests", "verify_resume_tests"], ROOT
    raise SystemExit(f"unknown suite {suite}")


def sh(argv, log, env=None, timeout=None):
    started = time.time()
    with open(log, "ab") as out:
        out.write(("\n$ " + " ".join(argv) + "\n").encode())
        out.flush()
        try:
            proc = subprocess.run(argv, cwd=ROOT, stdout=out, stderr=subprocess.STDOUT, env=env, timeout=timeout)
            code = proc.returncode
        except subprocess.TimeoutExpired:
            out.write(b"\n[mutation runner] TIMEOUT\n")
            code = "timeout"
    return code, time.time() - started


FAILED_TEST = re.compile(r"^test (\S+) \.\.\. (FAILED|ok|ignored)", re.M)
PANIC_CASE = re.compile(r"^(FAIL|XPASS) +(\S+)", re.M)


def read_records(report_dir):
    out = {}
    for path in glob.glob(os.path.join(report_dir, "*.jsonl")):
        for line in open(path, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = r.get("case", "?")
            out[key] = dict(
                outcome=r.get("outcome"),
                failures=sorted((r.get("failures") or {}).keys()),
                summary=(r.get("summary") or "")[:600],
            )
    return out


def run_suite(suite, platform, out_dir, extra_env):
    _, run_argv, _ = suite_commands(suite, platform)
    report_dir = os.path.join(out_dir, f"report-{suite}")
    shutil.rmtree(report_dir, ignore_errors=True)
    os.makedirs(report_dir, exist_ok=True)
    env = dict(os.environ)
    env.update(extra_env)
    env["CAP_VERIFY_REPORT_DIR"] = report_dir
    env.setdefault("CAP_VERIFY_TIER", "fast")
    log = os.path.join(out_dir, f"{suite}.log")
    if os.path.exists(log):
        os.remove(log)
    code, secs = sh(run_argv, log, env=env, timeout=SUITE_TIMEOUT)
    text = open(log, encoding="utf-8", errors="replace").read()
    tests = {name: status for name, status in FAILED_TEST.findall(text)}
    records = read_records(report_dir)
    return dict(
        exit=code,
        seconds=round(secs, 1),
        failed_tests=sorted(n for n, s in tests.items() if s == "FAILED"),
        bad_cases={k: v for k, v in records.items() if v["outcome"] in ("Fail", "Xpass", "fail", "xpass")},
        case_count=len(records),
        tail=text[-3000:] if code not in (0,) else "",
    )


def diff_against_baseline(res, base):
    """New failures relative to the baseline run of the same suite."""
    new_cases = {k: v for k, v in res["bad_cases"].items() if k not in base["bad_cases"]}
    new_tests = [t for t in res["failed_tests"] if t not in base["failed_tests"]]
    crashed = res["exit"] not in (0,) and not res["failed_tests"] and not res["bad_cases"]
    base_crashed = base["exit"] not in (0,) and not base["failed_tests"] and not base["bad_cases"]
    return new_cases, new_tests, crashed and not base_crashed


def build(suites, platform, log):
    for suite in suites:
        argv, _, _ = suite_commands(suite, platform)
        code, _ = sh(argv, log, timeout=5400)
        if code != 0:
            return suite
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", required=True)
    ap.add_argument("--ids", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--suites", default="")
    ap.add_argument("--baseline-runs", type=int, default=1)
    ap.add_argument("--fresh-fixtures", action="store_true",
                    help="regenerate fixtures for every mutation (pipeline-recorded fixtures follow the mutated code)")
    args = ap.parse_args()

    ids = args.ids.split()
    muts = [BY_ID[i] for i in ids]
    forced = [s for s in args.suites.split(",") if s]

    def suites_for(m):
        s = forced or m["suites"]
        if args.platform != "macos":
            s = [x for x in s if x != "recording"]
        return s

    all_suites = []
    for m in muts:
        for s in suites_for(m):
            if s not in all_suites:
                all_suites.append(s)

    os.makedirs(args.out, exist_ok=True)
    results_path = os.path.join(args.out, "results.jsonl")
    build_log = os.path.join(args.out, "build.log")
    fixture_root = os.environ.get("CAP_VERIFY_FIXTURE_DIR", os.path.join(ROOT, "target", "verify-fixtures"))

    failed_suite = build(all_suites, args.platform, build_log)
    if failed_suite:
        print(f"baseline build failed for {failed_suite}; see {build_log}")
        sys.exit(2)

    baseline = {}
    for run in range(args.baseline_runs):
        bdir = os.path.join(args.out, f"baseline-{run}")
        os.makedirs(bdir, exist_ok=True)
        for s in all_suites:
            r = run_suite(s, args.platform, bdir, {})
            print(f"baseline[{run}] {s}: exit {r['exit']} {r['seconds']} s, {len(r['bad_cases'])} bad cases, failed tests {r['failed_tests']}")
            prev = baseline.get(s)
            if prev is None:
                baseline[s] = r
            else:
                prev["bad_cases"].update(r["bad_cases"])
                prev["failed_tests"] = sorted(set(prev["failed_tests"]) | set(r["failed_tests"]))
                if prev["exit"] == 0:
                    prev["exit"] = r["exit"]
    with open(os.path.join(args.out, "baseline.json"), "w") as f:
        json.dump(baseline, f, indent=1)

    for m in muts:
        mdir = os.path.join(args.out, m["id"])
        os.makedirs(mdir, exist_ok=True)
        started = time.time()
        subprocess.run([sys.executable, os.path.join(HERE, "apply.py"), "apply", m["id"]], cwd=ROOT, check=True)
        entry = dict(id=m["id"], area=m["area"], platform=args.platform, title=m["title"], suites={})
        try:
            suites = suites_for(m)
            failed_suite = build(suites, args.platform, os.path.join(mdir, "build.log"))
            if failed_suite:
                entry["status"] = "compile-error"
                entry["detail"] = open(os.path.join(mdir, "build.log"), errors="replace").read()[-4000:]
            else:
                caught_by = []
                extra_env = {}
                if args.fresh_fixtures:
                    fresh = os.path.join(args.out, "fresh-fixtures")
                    shutil.rmtree(fresh, ignore_errors=True)
                    extra_env["CAP_VERIFY_FIXTURE_DIR"] = fresh
                for s in suites:
                    r = run_suite(s, args.platform, mdir, extra_env)
                    new_cases, new_tests, crashed = diff_against_baseline(r, baseline[s])
                    entry["suites"][s] = dict(
                        exit=r["exit"],
                        seconds=r["seconds"],
                        new_failing_cases={k: dict(outcome=v["outcome"], classes=v["failures"], summary=v["summary"]) for k, v in new_cases.items()},
                        new_failing_tests=new_tests,
                        crashed=crashed,
                        tail=r["tail"][-1500:] if (new_cases or new_tests or crashed) else "",
                    )
                    if new_cases or new_tests or crashed:
                        caught_by.append(s)
                entry["status"] = "caught" if caught_by else "missed"
                entry["caught_by"] = caught_by
        finally:
            subprocess.run([sys.executable, os.path.join(HERE, "apply.py"), "revert", m["id"]], cwd=ROOT, check=True)
        entry["seconds"] = round(time.time() - started, 1)
        print(f"{m['id']} {args.platform}: {entry['status']} {entry.get('caught_by', '')} ({entry['seconds']} s)", flush=True)
        with open(results_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
        _ = fixture_root


if __name__ == "__main__":
    main()
