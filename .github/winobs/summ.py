#!/usr/bin/env python3
"""summ.py runs.jsonl [...] : medians (min..max) per machine/scene/fps/recorder for xbench and bench.py rows."""
import json, statistics, sys
from collections import defaultdict

ORDER = ["cap062", "cap063", "head", "obs", "obs-matched"]


def g(d, *ks):
    for k in ks:
        if d is None:
            return None
        d = d.get(k) if isinstance(d, dict) else None
    return d


def fmt(vals, nd=1):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "-"
    m = statistics.median(vals)
    if len(vals) == 1:
        return f"{m:.{nd}f}"
    return f"{m:.{nd}f} ({min(vals):.{nd}f}..{max(vals):.{nd}f})"


def main():
    rows = []
    for f in sys.argv[1:]:
        rows += [json.loads(l) for l in open(f) if l.strip()]
    cells = defaultdict(list)
    for r in rows:
        sd = r.get("stimulus_display") or {}
        res = f"{int(sd.get('px_w') or 0)}x{int(sd.get('px_h') or 0)}"
        key = (r.get("machine") + " " + res, r.get("scene") + ("-av" if r.get("audio") else ""), r.get("fps"), r.get("recorder"))
        cells[key].append(r)
    hdr = ["machine", "scene", "fps", "rec", "n", "uniq fps", "missed", "dup", "gaps", "longest ms", "cpu s/s",
           "mem steady MB", "mem peak MB", "MB/min", "kbps", "start ms", "stop ms", "enc", "obs skip/lag", "stim fps", "err"]
    print("| " + " | ".join(hdr) + " |")
    print("|" + "---|" * len(hdr))

    def sk(k):
        return (k[0], k[1], k[2], ORDER.index(k[3]) if k[3] in ORDER else 9)
    for k in sorted(cells, key=sk):
        rs = cells[k]
        ok = [r for r in rs if r.get("analysis")]
        res = [r.get("resources") or {} for r in rs]
        cpu = [x.get("cpu_s_per_s") for x in res]
        mem = [x.get("mem_steady_mb", x.get("footprint_mb_steady")) for x in res]
        peak = [x.get("mem_peak_mb", x.get("footprint_mb_lifetime_max")) for x in res]
        slope = [x.get("mem_slope_mb_per_min", x.get("footprint_mb_per_min")) for x in res]
        an = [r["analysis"] for r in ok]
        w = [a.get("window") or {} for a in an]
        missed = [x.get("missed", x.get("missed_versions")) for x in w]
        enc = sorted({str(g(r, "recorder_result", "cap_log", "encoder_from_log") or g(r, "obs_requested", "encoder") or g(r, "analysis", "encoder", "codec")) for r in rs})
        obs = [f"{g(r,'recorder_result','obs_log','encode_skipped') or 0}/{g(r,'recorder_result','obs_log','render_lagged') or 0}" for r in rs if r.get("kind") == "obs"]
        errs = sum(1 for r in rs if r.get("analysis_error") or r.get("error"))
        line = [k[0], k[1], str(k[2]), k[3], f"{len(ok)}/{len(rs)}",
                fmt([a.get("effective_fps_unique") for a in an], 2), fmt(missed, 0), fmt([x.get("duplicates") for x in w], 0),
                fmt([x.get("gaps") for x in w], 0), fmt([x.get("longest_gap_ms") for x in w], 1), fmt(cpu, 3), fmt(mem, 0), fmt(peak, 0),
                fmt(slope, 1), fmt([a.get("bitrate_kbps_window") for a in an], 0),
                fmt([g(r, "recorder_result", "startup_ms") for r in rs], 0), fmt([g(r, "recorder_result", "finalize_ms") for r in rs], 0),
                ",".join(enc)[:30], ",".join(obs) or "-", fmt([g(r, "stimulus", "achieved_fps") for r in rs], 1), str(errs)]
        print("| " + " | ".join(line) + " |")
    av = [r for r in rows if r.get("av")]
    if av:
        print("\nA/V sync (audio minus video, ms; beep played right after its frame was presented, so the absolute value includes output latency)\n")
        print("| machine | rec | track | n | median | spread | drift ms/min | beeps found/played |")
        print("|---|---|---|---|---|---|---|---|")
        tc = defaultdict(list)
        for r in av:
            for t in r["av"].get("tracks", []):
                tc[(r["machine"], r["recorder"], t["track"])].append((t, r["av"].get("beeps_played")))
        for k in sorted(tc, key=lambda k: (k[0], ORDER.index(k[1]) if k[1] in ORDER else 9, k[2])):
            ts = tc[k]
            print(f"| {k[0]} | {k[1]} | {k[2]} | {len(ts)} | {fmt([t.get('sync_median_ms') for t, _ in ts])} | "
                  f"{fmt([t.get('sync_spread_ms') for t, _ in ts])} | {fmt([t.get('drift_ms_per_min') for t, _ in ts], 1)} | "
                  f"{fmt([t.get('beeps_found') for t, _ in ts], 0)}/{fmt([b for _, b in ts], 0)} |")


if __name__ == "__main__":
    main()
