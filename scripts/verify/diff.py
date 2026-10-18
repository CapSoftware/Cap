import argparse
import fnmatch
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict


def load_na(path):

    out = []
    if path:
        for line in open(path, encoding="utf-8"):
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            glob, _, reason = line.partition("\t")
            out.append((glob.strip(), reason.strip()))
    return out


def na_reason(na, key):
    case = key.split("::", 1)[-1]
    for glob, reason in na:
        if fnmatch.fnmatchcase(case, glob) or fnmatch.fnmatchcase(key, glob):
            return reason
    return None


def lane_of(artifact):
    m = re.match(r"verify-report-(.+?)-(fast|full)(-\d+)?$", artifact)
    if m:
        return m.group(1)
    m = re.match(r"verify-recording-(?:report-)?(.+)$", artifact)
    if m:
        return "recording-" + m.group(1)
    return artifact


def load(roots):



    records = defaultdict(lambda: defaultdict(list))
    junit = defaultdict(dict)
    for root in roots.split(","):
        if not os.path.isdir(root):
            sys.exit(f"no such directory: {root}")
        load_one(root, records, junit)
    return records, junit


def load_one(root, records, junit):
    for artifact in sorted(os.listdir(root)):
        base = os.path.join(root, artifact)
        if not os.path.isdir(base):
            continue
        lane = lane_of(artifact)
        for dirpath, _, files in os.walk(base):
            for name in sorted(files):
                path = os.path.join(dirpath, name)
                if name.endswith(".jsonl"):
                    with open(path, encoding="utf-8", errors="replace") as fh:
                        for line in fh:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                r = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if "case" not in r:
                                continue
                            key = f"{r.get('suite', '?')}::{r['case']}"
                            repeat = next((n for n in r.get("notes", []) if n.startswith("repeat ")), "single")
                            r["_sample"] = f"{os.path.realpath(root)}:{repeat}"
                            records[lane][key].append(r)
                elif name.startswith("junit") and name.endswith(".xml"):
                    try:
                        tree = ET.parse(path)
                    except ET.ParseError:
                        continue
                    for case in tree.getroot().iter("testcase"):
                        test = f"{case.get('classname', '')} {case.get('name', '')}".strip()
                        status = "pass"
                        if case.find("failure") is not None:
                            status = "fail"
                        elif case.find("error") is not None:
                            status = "error"
                        elif case.find("skipped") is not None:
                            status = "skipped"
                        elif case.find("flakyFailure") is not None or case.find("rerunFailure") is not None:
                            status = "flaky-pass"
                        prev = junit[lane].get(test)
                        rank = {"pass": 0, "skipped": 0, "flaky-pass": 1, "fail": 2, "error": 3}
                        if prev is None or rank[status] > rank[prev]:
                            junit[lane][test] = status


def magnitude(rng):
    try:
        lo, hi = rng
        return max(abs(float(lo)), abs(float(hi)))
    except (TypeError, ValueError):
        return None


def normalized_measures(record):
    measures = {cls: dict(metrics or {}) for cls, metrics in (record.get("measures") or {}).items()}
    if record.get("case") != "export/instant/output/mp4/native":
        return measures
    unobserved = record.get("unobserved") or {}
    if "sync-mic" in unobserved or "sync-system" in unobserved:
        return measures
    mic = measures.get("sync-mic", {}).get("offset-ms")
    system = measures.get("sync-system", {}).get("offset-ms")
    if mic is not None and system is not None:
        # Historical source offsets are already rounded to 0.1 ms. Subtract their
        # signed intervals without inventing precision or replacing newer telemetry.
        metrics = measures["sync-system"]
        metrics.setdefault("mic-offset-ms", mic)
        metrics.setdefault("system-minus-mic-ms", [round(system[0] - mic[1], 1), round(system[1] - mic[0], 1)])
    return measures


def fresh_fixture(case):
    return case.startswith(("recording/", "crash/", "export/instant", "export/rec-"))


def timing_resolution(metric):
    if metric.endswith("-start-late-ms"):
        return 1.0
    if metric in {"secs", "screen-lost-s", "off-periods"} or metric.endswith("-after-start-s"):
        return 0.01
    if metric.endswith("-ms"):
        return 0.1
    if metric.endswith("-s"):
        return 1e-9
    return None


def metric_resolution(metric):
    resolution = timing_resolution(metric)
    return resolution if resolution is not None else 1.0


def summarize(recs):
    ran = [r for r in recs if str(r.get("outcome", "")).lower() != "unsupported"]
    decisive = [r for r in ran if str(r.get("outcome", "")).lower() != "inconclusive"] or ran
    outcomes = sorted({str(r.get("outcome", "?")).lower() for r in recs})
    grouped = defaultdict(list)
    for index, r in enumerate(decisive):
        grouped[r.get("_sample", index)].append(r)
    class_runs = defaultdict(int)
    measures = defaultdict(dict)
    samples = []
    for group in grouped.values():
        classes = set().union(*(set(r.get("failures") or {}) for r in group))
        unobserved = set.intersection(*(set(r.get("unobserved") or {}) for r in group)) - classes
        sample = {"classes": classes, "measures": defaultdict(dict), "unobserved": unobserved}
        for cls in classes:
            class_runs[cls] += 1
        for r in group:
            for cls, metrics in normalized_measures(r).items():
                for metric, rng in (metrics or {}).items():
                    value = magnitude(rng)
                    if value is None:
                        continue
                    sample["measures"][cls][metric] = max(value, sample["measures"][cls].get(metric, 0))
                    measures[cls][metric] = max(value, measures[cls].get(metric, 0))
        samples.append(sample)
    unobserved = set.intersection(*(s["unobserved"] for s in samples)) if samples else set()
    why = sorted({(r.get("problems") or {}).get("unsupported", "") or r.get("summary", "") for r in recs if str(r.get("outcome", "")).lower() == "unsupported"})
    return {
        "why": why,
        "case": next((r.get("case", "") for r in recs), ""),
        "ran": bool(ran),
        "runs": len(samples),
        "outcomes": outcomes,
        "classes": dict(class_runs),
        "measures": {k: dict(v) for k, v in measures.items()},
        "unobserved": unobserved,
        "samples": samples,
    }


def coverage_gained(b, m):
    return sorted(b["unobserved"] - m["unobserved"]) if m["ran"] else []


def coverage_lost(b, m):
    return sorted(m["unobserved"] - b["unobserved"]) if b["ran"] and m["ran"] else []


def distribution(summary, cls, metric):
    values = []
    for sample in summary["samples"]:
        if cls in sample["unobserved"]:
            continue
        if cls not in sample["classes"]:
            values.append(0)
        elif metric in sample["measures"].get(cls, {}):
            values.append(sample["measures"][cls][metric])
    return values


def larger(a, b, rel, abs_):
    return a > b + max(abs_, rel * abs(b))


def beyond_resolution(a, b, rel, abs_):
    limit = b + max(abs_, rel * abs(b))
    return a > limit and not math.isclose(a, limit, rel_tol=1e-12, abs_tol=1e-12)


def compare_case(b, m, rel, abs_):

    worse, better, pending, overlap = [], [], [], []
    gained = coverage_gained(b, m)
    if b["ran"] and not m["ran"]:
        return "WORSE", [f"unsupported on main (baseline {'/'.join(b['outcomes'])})"]
    if not b["ran"] and m["ran"]:
        return "N/A", ["unsupported on baseline: " + "; ".join(b.get("why", [])[:1])]
    if not b["ran"] and not m["ran"]:
        return "EQUAL", []
    lost = coverage_lost(b, m)
    worse.extend(f"{cls}: baseline observed -> main unobserved (lost coverage)" for cls in lost)
    bc, mc = b["classes"], m["classes"]
    fresh = fresh_fixture(b["case"]) or fresh_fixture(m["case"])
    if fresh and (b["runs"] < 3 or m["runs"] < 3):
        pending.append("fresh fixture comparison requires at least 3 independent runs per side on this OS image")
    sampled_classes = {
        cls for cls in set(bc) | set(mc)
        if fresh or any(timing_resolution(metric) is not None for metric in
                        set(b["measures"].get(cls, {})) | set(m["measures"].get(cls, {})))
    }
    stochastic = "missing-after-hold"
    distribution_classes = (set(bc) | set(mc)) & {stochastic}
    if b["case"].startswith("recording/") or m["case"].startswith("recording/"):
        distribution_classes.add(stochastic)
    for cls in sorted(distribution_classes - set(lost)):
        metrics = {"count"} | set(b["measures"].get(cls, {})) | set(m["measures"].get(cls, {}))
        for metric in sorted(metrics):
            bv, mv = distribution(b, cls, metric), distribution(m, cls, metric)
            description = f"{cls}.{metric} baseline={bv}, main={mv}"
            if len(bv) < 3 or len(mv) < 3:
                pending.append(description + " (requires at least 3 independent runs per side on this OS image)")
            elif min(mv) > max(bv):
                worse.append(description + " (every main count above baseline range)")
            elif max(mv) < min(bv):
                better.append(description + " (every main count below baseline range)")
            elif bv != mv:
                overlap.append(description + " (ranges overlap)")
    for cls in sorted(set(mc) - set(bc) - set(gained) - {stochastic}):
        if cls in sampled_classes and (b["runs"] < 3 or m["runs"] < 3):
            pending.append(f"+{cls} (requires at least 3 independent runs per side on this OS image)")
        elif cls in sampled_classes and mc[cls] != m["runs"]:
            overlap.append(f"+{cls} in {mc[cls]}/{m['runs']} main runs (ranges overlap)")
        else:
            worse.append(f"+{cls}")
    for cls in sorted(set(bc) - set(mc) - {stochastic}):
        if cls in m["unobserved"]:
            continue
        if cls in sampled_classes and (b["runs"] < 3 or m["runs"] < 3):
            pending.append(f"-{cls} (requires at least 3 independent runs per side on this OS image)")
        elif cls in sampled_classes and bc[cls] != b["runs"]:
            overlap.append(f"-{cls} in {bc[cls]}/{b['runs']} baseline runs (ranges overlap)")
        else:
            better.append(f"-{cls}")
    for cls in sorted((set(bc) & set(mc)) - {stochastic}):
        if cls not in sampled_classes and b["runs"] and m["runs"] and (b["runs"] > 1 or m["runs"] > 1):
            bf, mf = bc[cls] / b["runs"], mc[cls] / m["runs"]
            if mf > bf:
                worse.append(f"{cls} fails {mc[cls]}/{m['runs']} vs {bc[cls]}/{b['runs']}")
            elif mf < bf:
                better.append(f"{cls} fails {mc[cls]}/{m['runs']} vs {bc[cls]}/{b['runs']}")
        bm, mm = b["measures"].get(cls, {}), m["measures"].get(cls, {})
        for metric in sorted(set(bm) | set(mm)):
            if metric == "frame":
                continue
            if fresh or timing_resolution(metric) is not None:
                bv, mv = distribution(b, cls, metric), distribution(m, cls, metric)
                resolution = metric_resolution(metric)
                description = f"{cls}.{metric} baseline={bv}, main={mv}, resolution={resolution:g}"
                if len(bv) < 3 or len(mv) < 3:
                    pending.append(description + " (requires at least 3 independent runs per side on this OS image)")
                elif beyond_resolution(min(mv), max(bv), rel, max(abs_, resolution)):
                    worse.append(description + " (every main value above baseline range by more than resolution)")
                elif beyond_resolution(min(bv), max(mv), rel, max(abs_, resolution)):
                    better.append(description + " (every main value below baseline range by more than resolution)")
                elif bv != mv:
                    overlap.append(description + " (ranges overlap within resolution)")
            elif metric in bm and metric in mm:
                if larger(mm[metric], bm[metric], rel, abs_):
                    worse.append(f"{cls}.{metric} {fmt(bm[metric])} -> {fmt(mm[metric])}")
                elif larger(bm[metric], mm[metric], rel, abs_):
                    better.append(f"{cls}.{metric} {fmt(bm[metric])} -> {fmt(mm[metric])}")
            elif metric in mm:
                worse.append(f"{cls}.{metric} new on main ({fmt(mm[metric])})")
    if worse:
        return "WORSE", worse + ([f"(also better: {', '.join(better)})"] if better else [])
    if pending:
        return "INSUFFICIENT", pending + better + overlap
    if better:
        return "BETTER", better + overlap
    if overlap:
        return "OVERLAP", overlap
    if gained:
        return "COVERAGE-GAINED", [f"{cls}: baseline unobserved -> main observed" for cls in gained]
    return "EQUAL", []


def fmt(x):
    return f"{x:.4g}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("main")
    ap.add_argument("--rel-tol", type=float, default=0.0)
    ap.add_argument("--abs-tol", type=float, default=0.0)
    ap.add_argument("--json")
    ap.add_argument("--title", default="baseline vs main")
    ap.add_argument("--na", help="file of 'case-glob<TAB>reason' lines: cases n/a on the baseline")
    ap.add_argument("--fail-on-worse", action="store_true", help="exit 1 when any lane has WORSE or junit WORSE rows")
    args = ap.parse_args()

    na = load_na(args.na)
    brec, bjunit = load(args.base)
    mrec, mjunit = load(args.main)
    lanes = sorted(set(brec) | set(mrec) | set(bjunit) | set(mjunit))
    out = {}
    print(f"# {args.title}\n")
    print(f"tolerance: rel {args.rel_tol}, abs {args.abs_tol}\n")
    print("| lane | cases base/main | WORSE | BETTER | EQUAL | coverage gained | coverage lost | insufficient | overlapping distributions | n/a on base | only base | only main | junit WORSE | junit BETTER |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    detail = []
    for lane in lanes:
        b, m = brec.get(lane, {}), mrec.get(lane, {})
        res = defaultdict(list)
        for key in sorted(set(b) | set(m)):
            if key in b and key not in m:
                bs = summarize(b[key])
                if bs["ran"]:
                    res["WORSE"].append((key, ["missing on main"]))
                res["ONLY-BASE"].append((key, []))
                continue
            if key in m and key not in b:
                reason = na_reason(na, key)
                if reason:
                    res["N/A"].append((key, [reason]))
                else:
                    res["ONLY-MAIN"].append((key, []))
                continue
            bs, ms = summarize(b[key]), summarize(m[key])
            verdict, reasons = compare_case(bs, ms, args.rel_tol, args.abs_tol)
            res[verdict].append((key, reasons))
            gained = coverage_gained(bs, ms)
            if gained and verdict != "COVERAGE-GAINED":
                res["COVERAGE-GAINED"].append((key, [f"{cls}: baseline unobserved -> main observed" for cls in gained]))
            lost = coverage_lost(bs, ms)
            if lost:
                res["COVERAGE-LOST"].append((key, [f"{cls}: baseline observed -> main unobserved (lost coverage)" for cls in lost]))
        bj, mj = bjunit.get(lane, {}), mjunit.get(lane, {})
        jworse, jbetter = [], []
        bad = {"fail", "error"}
        for test in sorted(set(bj) | set(mj)):
            bs, ms = bj.get(test), mj.get(test)
            if bs is not None and ms is None:
                if bs != "skipped":
                    jworse.append((test, [f"missing on main (baseline {bs})"]))
            elif bs is None:
                continue
            elif ms in bad and bs not in bad:
                jworse.append((test, [f"{bs} -> {ms}"]))
            elif bs in bad and ms not in bad:
                jbetter.append((test, [f"{bs} -> {ms}"]))
            elif bs == "error" and ms == "fail":
                jbetter.append((test, ["error -> fail"]))
            elif bs == "fail" and ms == "error":
                jworse.append((test, ["fail -> error (crash/timeout)"]))
        print(
            f"| {lane} | {len(b)}/{len(m)} | {len(res['WORSE'])} | {len(res['BETTER'])} | {len(res['EQUAL'])}"
            f" | {len(res['COVERAGE-GAINED'])} | {len(res['COVERAGE-LOST'])} | {len(res['INSUFFICIENT'])} | {len(res['OVERLAP'])} | {len(res['N/A'])} | {len(res['ONLY-BASE'])} | {len(res['ONLY-MAIN'])} | {len(jworse)} | {len(jbetter)} |"
        )
        out[lane] = {k: v for k, v in res.items()}
        out[lane]["JUNIT-WORSE"] = jworse
        out[lane]["JUNIT-BETTER"] = jbetter
        for label in ("WORSE", "BETTER", "COVERAGE-GAINED", "COVERAGE-LOST", "INSUFFICIENT", "OVERLAP", "JUNIT-WORSE", "JUNIT-BETTER", "N/A", "ONLY-BASE", "ONLY-MAIN"):
            items = out[lane].get(label) or []
            if not items:
                continue
            detail.append(f"\n## {lane}: {label} ({len(items)})\n")
            for key, reasons in items:
                detail.append(f"- `{key}`" + (f": {'; '.join(reasons)}" if reasons else ""))
    print("\n".join(detail))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(out, fh, indent=1, default=list)
    if args.fail_on_worse:
        # A unit test that main no longer has was renamed or removed with the
        # code it tested; the case-level rows cover the product.
        def counted(items):
            return [item for item in items or [] if not any(r.startswith("missing on main (baseline") for r in item[1])]

        worse = sum(len(counted(lane.get("WORSE"))) + len(counted(lane.get("JUNIT-WORSE"))) for lane in out.values())
        # A baseline run that stopped early, or a baseline suite that fell
        # behind main's, leaves main's cases unmatched. Cases new on main are
        # expected, a tenth of a lane is not.
        for lane in lanes:
            main_cases = len(mrec.get(lane) or {})
            only_main = len(out.get(lane, {}).get("ONLY-MAIN") or [])
            if main_cases and (not brec.get(lane) or only_main * 10 > main_cases):
                print(
                    f"lane {lane}: {only_main} of {main_cases} main cases have no baseline record "
                    "(re-run the baseline, or refresh its suite)",
                    file=sys.stderr,
                )
                worse += 1
        if worse:
            print(f"\n{worse} row(s) worse than the baseline", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
