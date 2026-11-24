"""Compares two probe runs: compare.py <out root> <base label> <head label> [<base repeat label>]

A case passes when head succeeds wherever base succeeds and every output is
byte-identical, or decodes to the same frames and audio. When a base repeat is
given, outputs that already differ between two base runs (a non-deterministic
encoder) pass if head matches base on stream layout and frame count instead.
"""

import json
import os
import sys

root, base_label, head_label = sys.argv[1:4]
repeat_label = sys.argv[4] if len(sys.argv) > 4 else None


def load(label):
    return json.load(open(os.path.join(root, label + ".json")))["cases"]


base, head = load(base_label), load(head_label)
repeat = load(repeat_label) if repeat_label else {}


def layout(info):
    streams = (info.get("probe") or {}).get("streams", [])
    keep = ("codec_type", "codec_name", "profile", "pix_fmt", "width", "height", "sample_rate", "channels", "sample_fmt")
    return [{key: stream.get(key) for key in keep} for stream in streams], info.get("video_frames")


def same(a, b):
    if a.get("sha256") == b.get("sha256"):
        return "bytes"
    if "video_md5" not in a:
        return None
    if a.get("video_md5") == b.get("video_md5") and a.get("audio_md5") == b.get("audio_md5"):
        return "decoded"
    return None


def media(case):
    found = dict(case.get("media") or {})
    for name, info in ((case.get("export") or {}).get("media") or {}).items():
        found["export/" + name] = info
    return found


rows, failures = [], 0
for name in sorted(set(base) | set(head)):
    b, h = base.get(name), head.get(name)
    if b is None or h is None:
        rows.append((name, "FAIL", f"only in {'head' if b is None else 'base'}"))
        failures += 1
        continue
    if not b.get("ok"):
        verdict = "same failure" if not h.get("ok") else "base failed, head ok"
        rows.append((name, "note", f"{verdict}: base {b.get('error', '')[:120]}"))
        continue
    if not h.get("ok"):
        rows.append((name, "FAIL", f"head failed: {h.get('error', '')[:300]}"))
        failures += 1
        continue
    bm, hm, rm = media(b), media(h), media(repeat.get(name) or {})
    problems, kinds = [], set()
    for file in sorted(set(bm) | set(hm)):
        if file not in bm or file not in hm:
            problems.append(f"{file} only in {'head' if file not in bm else 'base'}")
            continue
        match = same(bm[file], hm[file])
        if match:
            kinds.add(match)
            continue
        if file in rm and not same(bm[file], rm[file]):
            if layout(bm[file]) == layout(hm[file]) and not hm[file].get("decode_errors"):
                kinds.add("varies run to run; same layout")
                continue
        problems.append(f"{file} differs (base {bm[file].get('bytes')} B, head {hm[file].get('bytes')} B)")
    if problems:
        rows.append((name, "FAIL", "; ".join(problems)[:600]))
        failures += 1
    else:
        rows.append((name, "ok", ", ".join(sorted(kinds)) or "no media"))

width = max(len(row[0]) for row in rows) if rows else 10
for name, status, detail in rows:
    print(f"{status:5} {name:{width}}  {detail}")
print(f"\n{len(rows) - failures}/{len(rows)} match ({failures} regressions)")
sys.exit(1 if failures else 0)
