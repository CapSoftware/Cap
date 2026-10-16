#!/usr/bin/env python3
"""Decides which failed engine-verify tests may be retried once.

A failed test is retried only when the machine-starvation sentinel
(crates/verify/src/sentinel.rs) proves the runner starved it and the failure
is one that wall-clock timing can cause:

- every case it failed is `inconclusive` (a wall-clock class such as
  real-time playback `dropped`, under a sentinel wake gap of 100 ms or more,
  judged in cap_verify::report::settle), or
- nextest killed it at its timeout and its sentinel log shows such a gap, or
- it panicked in wgpu-core's queue drop ("We timed out while waiting on the
  last successful submission", a 6.3 s limit) and its sentinel log shows
  such a gap.

A test with any FAIL or XPASS case, or that crashed or timed out without
starvation evidence, is not retried: it fails the run as before. The retry
runs with CAP_VERIFY_RETRY=1, so a case that is inconclusive again fails as
`environment`.

Usage: retry.py <junit.xml> <report dir>
Prints one "binary<TAB>test<TAB>evidence" line per test to retry, then
"blocking<TAB><n>" with the number of failed tests that cannot be retried.
"""

import glob
import json
import os
import sys
import xml.etree.ElementTree as ET

STARVATION_GAP_MS = 100.0
QUEUE_DRAIN_PANIC = "We timed out while waiting on the last successful submission"


def records(report_dir):
    out = []
    for path in glob.glob(os.path.join(report_dir, "*.jsonl")):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def sentinels(report_dir):
    """(executable stem, argv, longest gap ms) per test process."""
    out = []
    for path in glob.glob(os.path.join(report_dir, "sentinel-*.log")):
        exe, args, longest = "", [], 0.0
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "args" in entry:
                    args = entry["args"]
                    exe = entry.get("exe", "")
                longest = max(longest, float(entry.get("gap_ms", 0.0)))
        out.append((exe, args, longest))
    return out


def main():
    junit, report_dir = sys.argv[1], sys.argv[2]
    recs = records(report_dir)
    logs = sentinels(report_dir)
    blocking = 0
    for case in ET.parse(junit).getroot().iter("testcase"):
        node = case.find("failure")
        if node is None:
            node = case.find("error")
        if node is None:
            continue
        binary, name = case.get("classname", ""), case.get("name", "")
        text = node.text or node.get("message") or ""
        mine = [r for r in recs if r.get("case") and r["case"] in text]
        bad = [r for r in mine if str(r.get("outcome", "")).lower() in ("fail", "xpass")]
        inconclusive = [r for r in mine if str(r.get("outcome", "")).lower() == "inconclusive"]
        timed_out = "timeout" in (node.get("type") or "").lower()
        # Test binaries are named after their target (export-<hash>): match
        # the target as well as the test name, which can repeat across them.
        target = binary.split("::")[-1].replace("-", "_")
        longest = max(
            (gap for exe, args, gap in logs if name in args and exe.replace("-", "_").startswith(target)),
            default=0.0,
        )
        if bad:
            blocking += 1
        elif timed_out and longest >= STARVATION_GAP_MS:
            print(f"{binary}\t{name}\ttimed out; sentinel longest wake gap {longest:.0f} ms")
        elif QUEUE_DRAIN_PANIC in text and longest >= STARVATION_GAP_MS:
            # wgpu-core gives a queue 6.3 s to finish its GPU work when the
            # last handle drops, then panics. A product lifecycle hazard (the
            # renderer should drain before release), excused only when the
            # sentinel proves the machine stalled.
            print(f"{binary}\t{name}\twgpu queue drain timed out; sentinel longest wake gap {longest:.0f} ms")
        elif inconclusive and not timed_out:
            cases = ", ".join(r["case"] for r in inconclusive)
            print(f"{binary}\t{name}\tinconclusive under starvation: {cases}")
        else:
            blocking += 1
    print(f"blocking\t{blocking}")


if __name__ == "__main__":
    main()
