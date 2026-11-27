"""Compare cap-verify jsonl reports across refs: evcmp.py label=dir label=dir ..."""
import collections
import glob
import json
import os
import re
import statistics
import sys

refs = [a.split("=", 1) for a in sys.argv[1:]]
data = {}
for label, d in refs:
    cases = {}
    for f in glob.glob(os.path.join(d, "*", "**", "*.jsonl"), recursive=True):
        art = os.path.relpath(f, d).split(os.sep)[0]
        plat = re.sub(r"^verify-(report|recording)-", "", art)
        plat = re.sub(r"-(full|fast)(-\d+)?$", "", plat)
        plat = re.sub(r"-\d+$", "", plat)
        for line in open(f):
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if "case" not in rec:
                continue
            key = (plat, rec["case"])
            cases.setdefault(key, []).append((rec.get("outcome"), rec.get("seconds") or 0, rec))
    data[label] = cases

labels = [l for l, _ in refs]
plats = sorted({p for l in labels for (p, _) in data[l]})
for p in plats:
    print(f"== {p}")
    for l in labels:
        c = collections.Counter(v[-1][0] for (pp, _), v in data[l].items() if pp == p)
        print(f"  {l}: {sum(c.values())} cases {dict(c)}")
    allcases = sorted({c for l in labels for (pp, c) in data[l] if pp == p})
    diffs = []
    for case in allcases:
        outs = []
        for l in labels:
            v = data[l].get((p, case))
            outs.append(",".join(o[0] for o in v) if v else "absent")
        last = [o.split(",")[-1] for o in outs]
        if len(set(last)) > 1 or any("fail" in o for o in outs):
            diffs.append((case, outs))
    for case, outs in diffs:
        print("   DIFF " + case + "  " + " | ".join(f"{l}={o}" for l, o in zip(labels, outs)))
    base = labels[0]
    for l in labels[1:]:
        ratios = []
        for (pp, case), v in data[l].items():
            if pp != p:
                continue
            b = data[base].get((p, case))
            if b and b[-1][1] > 1 and v[-1][1] > 1:
                ratios.append(v[-1][1] / b[-1][1])
        if ratios:
            print(f"  time {l}/{base}: median {statistics.median(ratios):.3f} n={len(ratios)} slower>1.2x: {sum(r > 1.2 for r in ratios)} faster<0.83x: {sum(r < 0.83 for r in ratios)}")
