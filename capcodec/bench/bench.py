#!/usr/bin/env python3
import argparse
import dataclasses
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import report  # noqa: E402
from harness.common import BENCH, MANIFEST, OUT_DIR, ROOT, Cache, ffmpeg_version, git_commit, log, ncores  # noqa: E402
from harness.runner import GATE_ENCODER, REFERENCE, TIERS, Bench, gate, machine_id, summarize  # noqa: E402

BEST = BENCH / "best.json"
HISTORY = BENCH / "history.jsonl"


def committed_best() -> dict | None:
    r = subprocess.run(["git", "-C", str(ROOT), "show", "HEAD:bench/best.json"], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return json.loads(r.stdout)
    if BEST.exists():
        return json.loads(BEST.read_text())
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="capcodec benchmark harness")
    ap.add_argument("tier", choices=sorted(TIERS))
    ap.add_argument("--encoders", help="comma-separated adapter names (prefix* allowed)")
    ap.add_argument("--clips", help="comma-separated clip names")
    ap.add_argument("--jobs", type=int, default=ncores())
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--manifest", type=Path, default=MANIFEST)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--update-best", action="store_true", help="write bench/best.json when the gate encoder improved")
    ap.add_argument("--accept", action="store_true", help="write bench/best.json from this run unconditionally")
    ap.add_argument("--no-history", action="store_true")
    ap.add_argument("--list", action="store_true", help="list adapters and availability")
    ap.add_argument("--quality-only", action="store_true",
                    help="skip speed, matched-speed and proportionality runs (speedcmp.py measures speed)")
    args = ap.parse_args()

    tier = TIERS[args.tier]
    if args.quality_only:
        tier = dataclasses.replace(tier, speed=False, matched_key=None, proportionality=False)
    out_dir = args.out or (OUT_DIR / tier.name)
    out_dir.mkdir(parents=True, exist_ok=True)
    encoders = args.encoders.split(",") if args.encoders else None
    clips = args.clips.split(",") if args.clips else None
    bench = Bench(tier, Cache(enabled=not args.no_cache), out_dir, encoders, clips, args.jobs, args.manifest)
    if args.list:
        for a in bench.adapters:
            print(f"available    {a.name:34s} {a.description}")
        for n, why in sorted(bench.unavailable.items()):
            print(f"unavailable  {n:34s} {why}")
        return 0
    if not bench.clips:
        log(f"no clips available (manifest {args.manifest}); generate the corpus first")
        return 2
    t0 = time.time()
    rows = bench.run()
    refs = [REFERENCE] + sorted({a.name for a in bench.adapters if getattr(a, "production", False)})
    refs = [r for r in refs if any(x["encoder"] == r for x in rows)]
    summ = summarize(rows, tier, refs)
    report.write_csv(rows, out_dir / "results.csv")
    (out_dir / "summary.json").write_text(json.dumps(summ, indent=1, sort_keys=True, default=str))
    notes = []
    if any(a.family == "browser" for a in bench.adapters):
        notes.append("Browser encoders run in headless Google Chrome on Linux, so MediaRecorder and WebCodecs use "
                     "Chrome's software H.264 path (OpenH264), not a hardware encoder.")
    if bench.unavailable:
        notes.append("Not available on this machine: " + ", ".join(f"{k} ({v})" for k, v in sorted(bench.unavailable.items())))
    meta = {"tier": tier.name, "commit": git_commit(), "machine": machine_id(), "ffmpeg": ffmpeg_version(),
            "clips": len(bench.clips), "elapsed_s": f"{time.time() - t0:.0f}"}
    ok, msgs = (True, [])
    best = committed_best()
    if tier.gate:
        ok, msgs = gate(summ["summary"], best)
    report.write_html(out_dir / "report.html", tier.name, rows, summ, refs, meta, out_dir / "crops", notes + msgs)
    entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "tier": tier.name, "commit": git_commit(),
             "machine": machine_id(), "elapsed_s": round(time.time() - t0, 1), "clips": [c.name for c in bench.clips],
             "summary": summ["summary"], "gate": {"ok": ok, "messages": msgs} if tier.gate else None}
    if not args.no_history:
        report.append_history(HISTORY, entry)
    s = summ["summary"].get(GATE_ENCODER, {})
    cand = {"bd_psnr_yuv": s.get(f"bd_psnr_yuv_vs_{REFERENCE}"), "cpu_fps": s.get("cpu_fps_median"),
            "commit": git_commit(), "tier": tier.name, "clips": [c.name for c in bench.clips]}
    if tier.gate and cand["bd_psnr_yuv"] is not None:
        better = best is None or (
            (best.get("bd_psnr_yuv") is None or cand["bd_psnr_yuv"] <= best["bd_psnr_yuv"])
            and (not best.get("cpu_fps") or (cand["cpu_fps"] or 0) >= best["cpu_fps"] * 0.97))
        if args.accept or (args.update_best and ok and better):
            BEST.write_text(json.dumps(cand, indent=1, sort_keys=True) + "\n")
            msgs.append(f"wrote {BEST}")
    for e, s in sorted(summ["summary"].items()):
        bits = [f"{k}={v:+.2f}%" if k.startswith("bd_") and not k.endswith("_n") else None
                for k, v in s.items() if v is not None]
        bits = [b for b in bits if b]
        fps = s.get("cpu_fps_median")
        sp = s.get("speed_wall_fps_median")
        print(f"{e:34s} {' '.join(bits)}  cpu-fps={'' if fps is None else f'{fps:.1f}'}"
              f"{'' if sp is None else f' wall-fps={sp:.1f}'} decode_fail={s.get('decode_failures')} "
              f"errors={s.get('errors')}")
        for surf, t in sorted((s.get("vs_cap_targets") or {}).items()):
            deltas = [f"{label}={t[k]:+.2f}" for label, k in (("dVMAF", "d_vmaf_mean"), ("dPSNR", "d_psnr_yuv_mean"))
                      if t.get(k) is not None]
            if t.get("cpu_speedup_geomean"):
                deltas.append(f"cpu x{t['cpu_speedup_geomean']:.2f}")
            print(f"{'':34s} vs {surf} at Cap bpp targets ({t['n']}): |err| {t['our_abs_err_mean'] * 100:.1f}% "
                  f"(theirs {t['their_abs_err_mean'] * 100:.1f}%) {' '.join(deltas)}")
    for m in msgs:
        print(m)
    print(f"report: {out_dir / 'report.html'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
