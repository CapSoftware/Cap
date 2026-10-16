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
            # Retry records repeat cases of the main pass (counted with the
            # retries below), so they are not cases of their own.
            rel = os.path.relpath(path, d).replace(os.sep, "/")
            if rel.startswith("retry/"):
                continue
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
                    kind = node.get("type") or ""
                    if "timeout" in kind.lower() and "timed out" not in text:
                        text = f"{text}\n(test timed out: {kind})"
                    out.append((f"{case.get('classname', '')} {case.get('name', '')}".strip(), text))
                    break
    return out


def crash_excerpt(msg, limit):
    """The first panic (message and a few lines after it), else the tail."""
    lines = msg.splitlines()
    for i, line in enumerate(lines):
        if "timed out" in line:
            return [line for line in lines if "[cap-verify]" in line or "timed out" in line][-limit:]
        if "panicked at" in line or "error:" in line.lower():
            excerpt = []
            for follow in lines[i:i + 12]:
                if "stack backtrace" in follow.lower():
                    break
                excerpt.append(follow)
            return excerpt
    return lines[-limit:]


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


def retried(dirs):
    """Tests retried after a proven machine stall -> (evidence, passed)."""
    out = {}
    for d in dirs:
        path = os.path.join(d, "retried.txt")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                test, _, evidence = line.strip().partition(": ")
                if evidence == "failed again on retry":
                    out[test] = (out.get(test, ("", True))[0], False)
                elif test:
                    out[test] = (evidence, out.get(test, ("", True))[1])
    return out


def render(records, title, junit, flaky, text, retries=None):
    retries = retries or {}
    counts = {}
    for r in records:
        counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
    bad = [r for r in records if r["outcome"] in ("fail", "xpass")]
    xfails = [r for r in records if r["outcome"] == "xfail"]
    seconds = sum(float(r.get("seconds") or 0) for r in records)
    head = (
        f"{len(records)} cases: {counts.get('pass', 0)} pass, {counts.get('xfail', 0)} expected failures, "
        f"{counts.get('fail', 0)} FAILED, {counts.get('xpass', 0)} unexpectedly passing, "
        f"{counts.get('unsupported', 0)} unsupported ({seconds:.0f} s of case time)"
    )
    excused = {}
    for r in records:
        for kind in (r.get("excused") or {}).values():
            excused[kind] = excused.get(kind, 0) + 1
    if excused.get("flaky") or excused.get("flaky, starved"):
        head += (
            f"; expected failures excused by flaky entries: {excused.get('flaky', 0)}, "
            f"only under a proven machine stall: {excused.get('flaky, starved', 0)}"
        )
    second = [
        r for r in records
        if any(str(n).startswith("inconclusive, retrying") for n in r.get("notes") or [])
    ]
    if second:
        head += f"; {len(second)} real-capture case(s) settled on a second attempt after a proven input fault"
    service = 0
    for r in records:
        for n in r.get("notes") or []:
            n = str(n)
            if n.startswith("capture-service drops:"):
                try:
                    service += int(n.split(": ")[2].split(" ")[0])
                except (IndexError, ValueError):
                    service += 1
    if service:
        head += f"; {service} missing picture(s) excused because the capture service dropped them for every client"
    unmeasured = [r for r in records if r.get("unobserved")]
    if unmeasured:
        head += f"; {len(unmeasured)} with classes not measured because an earlier check failed"
    # A failed test is explained only by a failing case it recorded. A test
    # that timed out or crashed after recording passing or expected cases
    # still failed: the cases after the last record never ran.
    failing = {r["case"] for r in bad}
    crashed = [
        (name, msg)
        for name, msg in junit
        if not any(c in msg for c in failing) and not retries.get(name, ("", False))[1]
    ]
    inconclusive = [r for r in records if r["outcome"] == "inconclusive"]
    if inconclusive or retries:
        passed = sum(1 for _, ok in retries.values() if ok)
        head += f"; {len(inconclusive)} inconclusive under a proven machine stall, {passed} of {len(retries)} retried tests passed"
    if crashed:
        head += f"; {len(crashed)} test(s) FAILED without a failing case (timed out or crashed, later cases not run)"
    out = []
    if text:
        out.append(f"== engine verify {title}: {head}")
        for r in bad:
            out.append(f"{r['outcome'].upper()} {r['case']}")
            out.extend("    " + line for line in details(r))
            if r.get("repro"):
                out.append(f"    repro: {r['repro']}")
        for test, (evidence, ok) in retries.items():
            out.append(f"RETRIED {test}: {evidence}: {'passed on retry' if ok else 'FAILED again (environment)'}")
        for name, msg in crashed:
            out.append(f"TEST FAILED {name}")
            out.extend("    " + line for line in crash_excerpt(msg, 15))
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
    if retries:
        out.append("### Retried after a proven machine stall")
        out.append("The starvation sentinel recorded the runner not scheduling the test; only wall-clock failures are retried, once.")
        out.extend(
            f"- `{test}`: {evidence}: {'passed on retry' if ok else '**failed again (environment)**'}"
            for test, (evidence, ok) in retries.items()
        )
        out.append("")
    if crashed:
        out.append("### Tests that failed without a case record")
        for name, msg in crashed[:MAX_CASES]:
            out.append(f"**`{name}`**")
            out.append("```text")
            out.extend(crash_excerpt(msg, 25))
            out.append("```")
    unsupported = [r for r in records if r["outcome"] == "unsupported"]
    if unsupported:
        out.append(f"<details><summary>Unsupported on this runner ({len(unsupported)})</summary>")
        out.append("")
        out.extend(f"- `{r['case']}`: {r.get('summary', '')}" for r in unsupported)
        out.append("")
        out.append("</details>")
    if xfails:
        out.append(f"<details><summary>Expected failures ({len(xfails)})</summary>")
        out.append("")
        out.append("| Case | Classes | Summary |")
        out.append("| --- | --- | --- |")
        for r in xfails:
            classes = ", ".join(sorted((r.get("failures") or {}).keys())) or "-"
            unmeasured = sorted((r.get("unobserved") or {}).keys())
            if unmeasured:
                classes += f" (not measured: {', '.join(unmeasured)})"
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
    print(
        render(
            load_records(args.dirs),
            args.title,
            junit_failures(args.junit),
            flaky,
            args.text,
            retried(args.dirs),
        )
    )


if __name__ == "__main__":
    main()
