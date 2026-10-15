#!/usr/bin/env python3
"""Summarises engine verification records (JSON lines written to
CAP_VERIFY_REPORT_DIR by every suite) as GitHub job-summary markdown or
plain text.

  summary.py [--title T] [--text] [--junit FILE]... [--flaky FILE] DIR...

Exit status is 0; the test runner's own exit status decides the job.
"""

import argparse
import glob
import json
import os
import xml.etree.ElementTree as ET

MAX_MISMATCHES = 12
MAX_CASES = 40


def load_records(dirs):
    records = []
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True)):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    r["case"] = r.get("case") or r.get("id", "?")
                    r["outcome"] = str(r.get("outcome", "?")).lower()
                    records.append(r)
    return records


def junit_failures(paths):
    """(test name, message) for failed or errored junit test cases."""
    out = []
    for path in paths:
        if not os.path.exists(path):
            continue
        for case in ET.parse(path).getroot().iter("testcase"):
            for tag in ("failure", "error"):
                node = case.find(tag)
                if node is not None:
                    text = (node.text or node.get("message") or "").strip()
                    out.append((f"{case.get('classname', '')} {case.get('name', '')}".strip(), text))
                    break
    return out


def frame(m):
    def fmt(v):
        return "none" if v is None else f"seg {v[0]} frame {v[1]}"
    delta = f", {m['delta']:+d} source frames" if m.get("delta") is not None else ""
    detail = f" ({m['detail']})" if m.get("detail") else ""
    return (
        f"output frame {m.get('output_frame')} at {m.get('time_secs', 0):.3f} s: {m.get('kind')} "
        f"expected {fmt(m.get('expected'))}, got {fmt(m.get('observed'))}{delta}{detail}"
    )


def details(r):
    lines = []
    summary = (r.get("summary") or "").strip()
    if summary:
        lines.extend(summary.splitlines())
    for stream in r.get("streams") or []:
        mismatches = stream.get("mismatches") or []
        if not mismatches:
            continue
        name = stream.get("stream") or "stream"
        lines.append(f"{name}: first {min(len(mismatches), MAX_MISMATCHES)} of {len(mismatches)} mismatches")
        lines.extend("  " + frame(m) for m in mismatches[:MAX_MISMATCHES])
    if not r.get("streams"):
        for class_name, problem in (r.get("problems") or {}).items():
            if problem not in summary:
                lines.append(f"{class_name}: {problem}")
    return lines


def render(records, title, junit, flaky, text):
    counts = {}
    for r in records:
        counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
    bad = [r for r in records if r["outcome"] in ("fail", "xpass")]
    xfails = [r for r in records if r["outcome"] == "xfail"]
    seconds = sum(float(r.get("seconds") or 0) for r in records)
    head = (
        f"{len(records)} cases: {counts.get('pass', 0)} pass, {counts.get('xfail', 0)} expected failures, "
        f"{counts.get('fail', 0)} FAILED, {counts.get('xpass', 0)} unexpectedly passing ({seconds:.0f} s of case time)"
    )
    recorded = {r["case"] for r in records}
    crashed = [(name, msg) for name, msg in junit if not any(c in msg for c in recorded)]
    out = []
    if text:
        out.append(f"== engine verify {title}: {head}")
        for r in bad:
            out.append(f"{r['outcome'].upper()} {r['case']}")
            out.extend("    " + line for line in details(r))
            if r.get("repro"):
                out.append(f"    repro: {r['repro']}")
        for name, msg in crashed:
            out.append(f"TEST FAILED {name}")
            out.extend("    " + line for line in msg.splitlines()[-15:])
        for name in flaky:
            out.append(f"FLAKY {name}: failed, then passed when rerun (still a failure: fix the cause)")
        return "\n".join(out)

    icon = "FAILED" if bad or crashed else "passed"
    out.append(f"## Engine verify, {title}: {icon}")
    out.append("")
    out.append(head)
    out.append("")
    if flaky:
        out.append("### Flaky")
        out.append("Failed, then passed when rerun once. The job still fails: find the nondeterminism.")
        out.extend(f"- `{name}`" for name in flaky)
        out.append("")
    if bad:
        out.append("### Failures")
        for r in bad[:MAX_CASES]:
            kind = "unexpectedly passes" if r["outcome"] == "xpass" else "FAILED"
            out.append(f"**`{r['case']}`** {kind} ({float(r.get('seconds') or 0):.1f} s)")
            out.append("```text")
            out.extend(details(r)[:MAX_MISMATCHES * 3])
            out.append("```")
            if r.get("repro"):
                out.append(f"Repro: `{r['repro']}`")
            out.append("")
        if len(bad) > MAX_CASES:
            out.append(f"... and {len(bad) - MAX_CASES} more (see the report artifact)")
    if crashed:
        out.append("### Tests that failed without a case record")
        for name, msg in crashed[:MAX_CASES]:
            out.append(f"**`{name}`**")
            out.append("```text")
            out.extend(msg.splitlines()[-25:])
            out.append("```")
    if xfails:
        out.append(f"<details><summary>Expected failures ({len(xfails)})</summary>")
        out.append("")
        out.append("| Case | Classes | Summary |")
        out.append("| --- | --- | --- |")
        for r in xfails:
            classes = ", ".join(sorted((r.get("failures") or {}).keys())) or "-"
            summary = (r.get("summary") or "").splitlines()[0:1]
            summary = summary[0].replace("|", "\\|")[:200] if summary else ""
            out.append(f"| `{r['case']}` | {classes} | {summary} |")
        out.append("")
        out.append("</details>")
    slow = sorted(records, key=lambda r: -float(r.get("seconds") or 0))[:10]
    if slow:
        out.append("<details><summary>Slowest cases</summary>")
        out.append("")
        out.extend(f"- {float(r.get('seconds') or 0):.1f} s `{r['case']}`" for r in slow)
        out.append("")
        out.append("</details>")
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dirs", nargs="+")
    parser.add_argument("--title", default="")
    parser.add_argument("--text", action="store_true")
    parser.add_argument("--junit", action="append", default=[])
    parser.add_argument("--flaky", help="file with one flaky test name per line")
    args = parser.parse_args()
    flaky = []
    if args.flaky and os.path.exists(args.flaky):
        with open(args.flaky) as f:
            flaky = [line.strip() for line in f if line.strip()]
    print(render(load_records(args.dirs), args.title, junit_failures(args.junit), flaky, args.text))


if __name__ == "__main__":
    main()
