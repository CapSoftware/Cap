#!/usr/bin/env python3
"""Executed-case floor for an engine-verify run.

  floor.py --matrix JSON --tier fast|full REPORTS_DIR
  floor.py --recording --runners JSON --tier fast|full REPORTS_DIR

REPORTS_DIR holds the downloaded report artifacts
(verify-report-<platform>-<tier>-<shard>/). For every platform and suite the
plan ran, the distinct case ids whose id starts with the suite's `cases.prefix`
(scripts/verify/suites.json) must reach the floor for this tier and platform,
and a suite with an exact `test` name must appear in the run's junit. A suite
that silently shrinks (a renamed test, a skip glob or catalog edit that drops
cases, a shard that never ran) fails the gate instead of passing vacuously.
With --recording, REPORTS_DIR holds the real-capture artifacts
(verify-recording-<runner>/verify-report): every runner must have recorded at
least suites.json's `recording.cases` floor of distinct real-capture cases.
Prints one line per check; exit status 1 when any check fails.
"""

import argparse
import glob
import json
import os
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def platform_reports(reports, platform, tier):
    return sorted(glob.glob(os.path.join(reports, f"verify-report-{platform}-{tier}-*")))


def case_ids(dirs):
    ids = set()
    for d in dirs:
        # Retry and flaky-rerun records count too: a timeout can stop a test
        # before its later cases write, and its retry then runs them.
        for path in glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if record.get("case"):
                        ids.add(record["case"])
    return ids


def junit_tests(dirs):
    names = set()
    for d in dirs:
        path = os.path.join(d, "junit.xml")
        if not os.path.exists(path):
            continue
        for case in ET.parse(path).getroot().iter("testcase"):
            names.add(case.get("name", ""))
    return names


def check(config, matrix, tier, reports):
    lines, failed = [], 0
    suites = {s["name"]: s for s in config["suites"]}
    for entry in matrix.get("include", []):
        platform = entry["platform"]
        dirs = platform_reports(reports, platform, tier)
        expected_shards = int(entry.get("shards", 1))
        if len(dirs) < expected_shards:
            failed += 1
            lines.append(f"FAIL {platform}: {len(dirs)} of {expected_shards} shard reports present")
        ids = case_ids(dirs)
        tests = junit_tests(dirs)
        for name in [n for n in entry["suites"].split(",") if n]:
            suite = suites[name]
            floors = suite.get("cases", {}).get(tier, {})
            floor = floors.get(platform, floors.get(entry.get("os", platform)))
            if floor is not None:
                prefix = suite["cases"]["prefix"]
                ran = sum(1 for i in ids if i.startswith(prefix))
                ok = ran >= floor
                failed += not ok
                lines.append(
                    f"{'ok  ' if ok else 'FAIL'} {platform} {name}: {ran} cases ran (floor {floor}, prefix {prefix})"
                )
            if suite.get("test"):
                ok = suite["test"] in tests
                failed += not ok
                lines.append(
                    f"{'ok  ' if ok else 'FAIL'} {platform} {name}: test {suite['test']} {'ran' if ok else 'is missing from the junit report'}"
                )
    return lines, failed


def check_recording(config, runners, tier, reports):
    lines, failed = [], 0
    floor = config.get("recording", {}).get("cases", {}).get(tier, 0)
    for runner in runners:
        d = os.path.join(reports, f"verify-recording-{runner}")
        ids = {
            i for i in case_ids([d])
            if i.startswith("recording/") and "(self-check" not in i
        }
        ok = os.path.isdir(d) and len(ids) >= floor
        failed += not ok
        lines.append(f"{'ok  ' if ok else 'FAIL'} {runner}: {len(ids)} real-capture cases recorded (floor {floor})")
    return lines, failed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix")
    parser.add_argument("--recording", action="store_true")
    parser.add_argument("--runners")
    parser.add_argument("--tier", required=True)
    parser.add_argument("reports")
    args = parser.parse_args()
    with open(os.path.join(ROOT, "scripts", "verify", "suites.json")) as f:
        config = json.load(f)
    if args.recording:
        lines, failed = check_recording(config, json.loads(args.runners), args.tier, args.reports)
    else:
        lines, failed = check(config, json.loads(args.matrix), args.tier, args.reports)
    print("\n".join(lines))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
