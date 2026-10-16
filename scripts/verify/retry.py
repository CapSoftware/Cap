#!/usr/bin/env python3
"""Decides which failed engine-verify tests may be retried once.

A failed test is retried only when the machine-starvation sentinel
(crates/verify/src/sentinel.rs) proves the runner starved it right where it
failed, and the failure is one that wall-clock timing can cause:

- every case it failed is `inconclusive` (a wall-clock class such as
  real-time playback `dropped`, under a sentinel wake gap of 100 ms or more
  during that case, judged in cap_verify::report::settle), or
- nextest killed it at its timeout and its sentinel log shows the process
  stalled for at least STALLED_MS in total (wake gaps of 100 ms or more) in
  the TIMEOUT_WINDOW_SECS before it was killed, or
- it panicked in wgpu-core's queue drop ("We timed out while waiting on the
  last successful submission", a 6.3 s limit) or on a lost GPU device
  ("Device with 'cap-rendering-device' label is invalid") and its sentinel
  log shows such stalls in the PANIC_WINDOW_SECS before the panic.

A gap anywhere else in a test's life is not evidence (an intermittent hang
after an unrelated stall is not excused). At most MAX_RETRIES tests are
retried per job; beyond that the job fails as an unusable machine.

A test with any FAIL or XPASS case, or that crashed or timed out without
starvation evidence, is not retried: it fails the run as before. The retry
runs with CAP_VERIFY_RETRY=1, so a case that is inconclusive again fails as
`environment`.

Usage: retry.py <junit.xml> <report dir>   (retry.py test: self-test)
Prints one "binary<TAB>test<TAB>evidence" line per test to retry, then
"blocking<TAB><n>" with the number of failed tests that cannot be retried.
"""

import glob
import json
import os
import sys
import xml.etree.ElementTree as ET

STARVATION_GAP_MS = 100.0
# Stalled time (sum of wake gaps of at least STARVATION_GAP_MS) that must
# fall inside the failure window.
STALLED_MS = 1000.0
TIMEOUT_WINDOW_SECS = 60.0
PANIC_WINDOW_SECS = 15.0
MAX_RETRIES = 3
QUEUE_DRAIN_PANIC = "We timed out while waiting on the last successful submission"
# The GPU device was lost (WARP gives up on work that takes too long) and the
# next wgpu call on it panics instead of reporting an error.
DEVICE_LOST_PANIC = "Device with 'cap-rendering-device' label is invalid"


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
    """(executable stem, argv, gaps [(start s, ms)], end s) per test process.
    The end is the last heartbeat or gap: the sentinel writes one every 2 s,
    so it is within about 2 s of when the process stopped."""
    out = []
    for path in glob.glob(os.path.join(report_dir, "sentinel-*.log")):
        exe, args, gaps, end = "", [], [], 0.0
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "args" in entry:
                    args = entry["args"]
                    exe = entry.get("exe", "")
                if "alive" in entry:
                    end = max(end, float(entry["alive"]))
                if "gap_ms" in entry:
                    at, gap = float(entry.get("at", 0.0)), float(entry["gap_ms"])
                    gaps.append((at, gap))
                    end = max(end, at + gap / 1000.0)
        out.append((exe, args, gaps, end))
    return out


def stalled(gaps, end, window):
    """Total ms of starvation gaps overlapping (end - window, end]."""
    start = end - window
    total = 0.0
    for at, gap in gaps:
        if gap < STARVATION_GAP_MS:
            continue
        overlap = min(at + gap / 1000.0, end) - max(at, start)
        if overlap > 0:
            total += overlap * 1000.0
    return total


def self_test():
    """Synthetic junit and sentinel logs: only a stall inside the failure
    window is evidence, and the per-job cap holds."""
    import tempfile

    failed = 0
    with tempfile.TemporaryDirectory() as d:
        def write(path, text):
            with open(os.path.join(d, path), "w", encoding="utf-8") as f:
                f.write(text)

        tests = []
        for i, (kind, gaps) in enumerate([
            ("timeout", [(890.0, 3000.0)]),
            ("timeout", [(30.0, 5000.0)]),
            ("timeout", [(880.0, 150.0)]),
            ("lost", [(895.0, 2000.0)]),
            ("lost", [(100.0, 9000.0)]),
            ("timeout", [(890.0, 2000.0)]),
            ("timeout", [(890.0, 2000.0)]),
            ("timeout", [(890.0, 2000.0)]),
        ]):
            name = f"t{i}"
            lines = [json.dumps({"pid": i, "exe": "export-abc", "args": [name, "--exact"]})]
            lines += [json.dumps({"at": at, "gap_ms": gap}) for at, gap in gaps]
            lines.append(json.dumps({"alive": 900.0}))
            write(f"sentinel-{i}.log", "\n".join(lines) + "\n")
            if kind == "timeout":
                body = '<failure type="test timeout">killed</failure>'
            else:
                body = f"<failure>{DEVICE_LOST_PANIC}</failure>"
            tests.append(f'<testcase classname="cap-verify::export" name="{name}">{body}</testcase>')
        write("junit.xml", "<testsuites><testsuite>" + "".join(tests) + "</testsuite></testsuites>")
        import contextlib
        import io

        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            sys.argv = ["retry.py", os.path.join(d, "junit.xml"), d]
            main()
        lines = out.getvalue().splitlines()
        retried = {line.split("\t")[1] for line in lines if not line.startswith("blocking")}
        blocking = next(int(line.split("\t")[1]) for line in lines if line.startswith("blocking"))
        expected_retried = {"t0", "t3", "t5"}
        if retried != expected_retried or blocking != 5:
            failed += 1
        print(f"{'ok ' if not failed else 'BAD'} retried {sorted(retried)} (expected {sorted(expected_retried)}), blocking {blocking} (expected 5)")
    sys.exit(1 if failed else 0)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(newline="\n")
    if sys.argv[1:] == ["test"]:
        self_test()
        return
    junit, report_dir = sys.argv[1], sys.argv[2]
    recs = records(report_dir)
    logs = sentinels(report_dir)
    blocking = 0
    retried = 0
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
        mine_logs = [
            (gaps, end)
            for exe, args, gaps, end in logs
            if name in args and exe.replace("-", "_").startswith(target)
        ]

        def evidence(window):
            return max((stalled(gaps, end, window) for gaps, end in mine_logs), default=0.0)

        reason = None
        if bad:
            pass
        elif timed_out:
            ms = evidence(TIMEOUT_WINDOW_SECS)
            if ms >= STALLED_MS:
                reason = f"timed out; the machine stalled the process {ms:.0f} ms in the {TIMEOUT_WINDOW_SECS:.0f} s before the kill"
        elif DEVICE_LOST_PANIC in text or QUEUE_DRAIN_PANIC in text:
            # Product hazards too (a lost device should be an error, not a
            # panic; the renderer should drain before release), excused only
            # when the sentinel proves the machine stalled right before.
            ms = evidence(PANIC_WINDOW_SECS)
            what = "wgpu device lost" if DEVICE_LOST_PANIC in text else "wgpu queue drain timed out"
            if ms >= STALLED_MS:
                reason = f"{what}; the machine stalled the process {ms:.0f} ms in the {PANIC_WINDOW_SECS:.0f} s before the panic"
        elif inconclusive:
            cases = ", ".join(r["case"] for r in inconclusive)
            reason = f"inconclusive under starvation: {cases}"
        if reason is None:
            blocking += 1
        elif retried >= MAX_RETRIES:
            blocking += 1
            print(f"::error title=Too many machine stalls::{binary} {name}: {reason} (more than {MAX_RETRIES} stalled tests in one job: the runner is unusable)", file=sys.stderr)
        else:
            retried += 1
            print(f"{binary}\t{name}\t{reason}")
    print(f"blocking\t{blocking}")


if __name__ == "__main__":
    main()
