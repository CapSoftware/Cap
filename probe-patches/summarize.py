"""Probe-only: one summary line per repetition of the jitter export.

usage: summarize.py LABEL REPORT_DIR TRACE_DIR OUT_DIR
Keeps only the camera lines of the jitter-camera-120s process traces in OUT_DIR.
"""
import glob
import json
import os
import re
import sys

label, report_dir, trace_dir, out_dir = sys.argv[1:5]
os.makedirs(out_dir, exist_ok=True)
case = "export/jitter-camera-120s/full/mp460/avf"
record = "no record"
for path in glob.glob(os.path.join(report_dir, "*.jsonl")):
    for line in open(path):
        if f'"case":"{case}"' in line:
            m = re.findall(r"camera: \d+ of \d+ frames wrong|nondeterministic: \d+ of \d+ frames differ[^\"]*?\)", line)
            outcome = json.loads(line).get("outcome")
            record = f"{outcome} " + " | ".join(sorted(set(m)))
parts = []
for path in glob.glob(os.path.join(trace_dir, "avfdbg-*.log")):
    lines = open(path, errors="replace").read().splitlines()
    jitter = {
        l.split()[0]
        for l in lines
        if " N path=" in l and "jitter-camera-120s" in l and l.split()[1] == "camera"
    }
    if not jitter:
        continue
    keep = [l for l in lines if l.split()[0] in jitter]
    with open(os.path.join(out_dir, os.path.basename(path)), "w") as f:
        f.write("\n".join(keep) + "\n")
    for inst in sorted(jitter, key=int):
        il = [l.split(maxsplit=4) + [""] for l in keep if l.split()[0] == inst]
        answers = sum(1 for p in il if p[3] == "A")
        requests = sum(1 for p in il if p[3] in ("B", "R"))
        teardowns = []
        for i, p in enumerate(il):
            if p[3] in ("T", "F"):
                nxt = next((q[4] for q in il[i + 1 :] if q[3] == "B"), "")
                fm = re.search(r"f=\[(\d+)", nxt)
                teardowns.append(
                    f"{p[3]}@{float(p[2]) / 1000:.1f}s->req{fm.group(1) if fm else '?'}"
                )
        waits = [
            float(m.group(1))
            for p in il
            if p[3] in ("B", "R")
            for m in [re.search(r"wait=([\d.]+)", p[4])]
            if m
        ]
        multi = sum(
            1 for p in il if p[3] == "B" and not re.match(r"n=[01] ", p[4])
        )
        scrub = sum(1 for p in il if p[3] == "B" and "scrub=true" in p[4])
        resets = sum(1 for p in il if p[3] == "S" and "reset=true" in p[4])
        sites = {}
        for p in il:
            if p[3] == "A":
                s = p[4].split()[0]
                sites[s] = sites.get(s, 0) + 1
        if requests < 100:
            continue
        parts.append(
            f"[inst {inst}: req={requests} answers={answers} teardowns={len(teardowns)} {' '.join(teardowns[:6])} "
            f"maxwait={max(waits, default=0):.0f}ms waits>200={sum(w > 200 for w in waits)} multi={multi} "
            f"scrub={scrub} resets={resets} sites={','.join(f'{k}:{v}' for k, v in sorted(sites.items()))}]"
        )
print(f"{label}: {record} :: {' '.join(parts)}", flush=True)
