#!/usr/bin/env python3
import argparse
import csv
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness.bdrate import bd_rate, overlap_fraction  # noqa: E402

PAIRS = [("capcodec-medium", "x264-veryfast", "medium"), ("capcodec-live", "x264-veryfast", "live"),
         ("capcodec-live-zerolatency", "x264-veryfast-zerolatency", "zerolatency")]
METRICS = [("vmaf", "VMAF"), ("psnr_yuv", "PSNR"), ("ssim", "SSIM")]


def num(v: str | None) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def load_rows(path: Path) -> list[dict]:
    with open(path / "results.csv") as f:
        return [r for r in csv.DictReader(f) if not r.get("kind") and not r.get("error")]


def curve(rows: list[dict], enc: str, clip: str, key: str) -> tuple[list[float], list[float]]:
    pts = [(num(r["kbps"]), num(r.get(key))) for r in rows if r["encoder"] == enc and r["clip"] == clip]
    pts = [(k, q) for k, q in pts if k and q is not None]
    return [k for k, _ in pts], [q for _, q in pts]


def mark(v: float | None, lower_is_better: bool = True, tie: float = 0.0) -> str:
    if v is None:
        return "n/a"
    good = v < -tie if lower_is_better else v > tie
    bad = v > tie if lower_is_better else v < -tie
    return f"{v:+.1f}% {'win' if good else 'lose' if bad else 'tie'}"


def quality_tables(rows: list[dict], label: str) -> tuple[list[str], dict]:
    clips = sorted({r["clip"] for r in rows})
    out = []
    tally = {}
    for cap, ref, mode in PAIRS:
        if not any(r["encoder"] == cap for r in rows) or not any(r["encoder"] == ref for r in rows):
            continue
        out += [f"### {label}: {cap} vs {ref} (BD-rate, negative = capcodec needs fewer bits)", "",
                "| clip | VMAF | PSNR-YUV | SSIM | VMAF range overlap |", "|---|---|---|---|---|"]
        wins = losses = 0
        for clip in clips:
            cells = []
            for key, _ in METRICS:
                rr, rq = curve(rows, ref, clip, key)
                tr, tq = curve(rows, cap, clip, key)
                v = bd_rate(rr, rq, tr, tq)
                cells.append(mark(v))
                if v is not None:
                    wins += v < 0
                    losses += v > 0
            _, rq = curve(rows, ref, clip, "vmaf")
            _, tq = curve(rows, cap, clip, "vmaf")
            out.append(f"| {clip} | {' | '.join(cells)} | {overlap_fraction(rq, tq):.0%} |")
        tally[mode] = (wins, losses)
        out += ["", f"{wins} wins, {losses} losses across {len(clips)} clips x 3 metrics.", ""]
    return out, tally


def speed_tables(speed: dict, label: str) -> list[str]:
    out = [f"### {label}: speed at matched VMAF (x264 / capcodec, interleaved medians, other work paused)", "",
           "| clip | mode | VMAF | CPU 1t | wall 1t | CPU 4t | wall 4t | peak RSS 4t capcodec / x264 MiB |",
           "|---|---|---|---|---|---|---|---|"]
    for e in sorted(speed.values(), key=lambda e: (e["mode"], e["clip"])):
        t1, t4 = e["threads"].get("1"), e["threads"].get("4")

        def r(d, k):
            return f"{d[k]:.2f}x {'win' if d[k] > 1 else 'lose'}" if d else "n/a"
        rss = f"{t4['capcodec']['rss_mb']:.0f} / {t4['x264']['rss_mb']:.0f}" if t4 else "n/a"
        out.append(f"| {e['clip']} | {e['mode']} | {e['target_vmaf']:.1f} | {r(t1, 'cpu_ratio')} | "
                   f"{r(t1, 'wall_ratio')} | {r(t4, 'cpu_ratio')} | {r(t4, 'wall_ratio')} | {rss} |")
    for mode in sorted({e["mode"] for e in speed.values()}):
        es = [e for e in speed.values() if e["mode"] == mode]
        for t in ("1", "4"):
            for k in ("cpu_ratio", "wall_ratio"):
                vs = [e["threads"][t][k] for e in es if t in e["threads"]]
                if vs:
                    g = math.exp(sum(math.log(v) for v in vs) / len(vs))
                    out.append(f"- {mode} {t} thread{'s' if t != '1' else ''} {k.split('_')[0]}: geometric mean "
                               f"{g:.2f}x, min {min(vs):.2f}x ({sum(v > 1 for v in vs)}/{len(vs)} clips faster)")
    out.append("")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="scoreboard against x264 from harness quality and speedcmp results")
    ap.add_argument("--quality", type=Path, action="append", default=[], help="LABEL=DIR with results.csv")
    ap.add_argument("--speed", type=Path, action="append", default=[], help="LABEL=DIR with results.json")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    lines = ["# Scoreboard against x264", ""]
    for spec in a.quality:
        label, _, d = str(spec).partition("=")
        if (Path(d) / "results.csv").exists():
            t, _ = quality_tables(load_rows(Path(d)), label)
            lines += t
    for spec in a.speed:
        label, _, d = str(spec).partition("=")
        p = Path(d) / "results.json"
        if p.exists():
            lines += speed_tables(json.loads(p.read_text()), label)
    a.out.write_text("\n".join(lines) + "\n")
    print(a.out)


if __name__ == "__main__":
    main()
