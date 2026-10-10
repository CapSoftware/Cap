#!/usr/bin/env python3
import argparse
import json
import os
import resource
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bench"))

from harness.corpus import load_manifest, prepare_source  # noqa: E402

STAGES = ["analysis", "motion", "mode", "tq", "entropy", "deblock"]


def child_cpu() -> float:
    r = resource.getrusage(resource.RUSAGE_CHILDREN)
    return r.ru_utime + r.ru_stime


def run_capcodec(binary: str, src, preset: str, crf: float, extra: list[str], frames: int, side: bool) -> dict:
    stats = Path(f"/tmp/profile_{src.clip.name}_{preset}.json")
    cmd = [binary, "encode", "--input", str(src.path), "--output", "/tmp/profile_out.264",
           "--width", str(src.width), "--height", str(src.height), "--fps", src.fps_arg,
           "--preset", preset, "--crf", str(crf), "--stats", str(stats), "--frames", str(frames)] + extra
    if side and src.sideinfo:
        cmd += ["--sideinfo", str(src.sideinfo)]
    c0 = child_cpu()
    t0 = time.perf_counter()
    r = subprocess.run(cmd, capture_output=True)
    wall = time.perf_counter() - t0
    cpu = child_cpu() - c0
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace"))
    s = json.loads(stats.read_text())
    s["wall_s"] = wall
    s["cpu_s"] = cpu
    return s


def run_x264(src, preset: str, crf: float, threads: int, frames: int) -> dict:
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p",
           "-s", f"{src.width}x{src.height}", "-r", src.fps_arg, "-i", str(src.path), "-frames:v", str(frames),
           "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-threads", str(threads), "-f", "h264",
           "/tmp/profile_x264.264"]
    c0 = child_cpu()
    t0 = time.perf_counter()
    r = subprocess.run(cmd, capture_output=True)
    wall = time.perf_counter() - t0
    cpu = child_cpu() - c0
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace"))
    return {"wall_s": wall, "cpu_s": cpu, "bytes": Path("/tmp/profile_x264.264").stat().st_size}


def report(name: str, s: dict, frames: int) -> None:
    fr = s["frames"]
    full = [f for f in fr if f["changed_mbs"] >= 0.9 * s["mbs"] and f["type"] == "P"]
    t = s["time_ms"]
    line = (f"{name:<28} wall {frames / s['wall_s']:7.1f} fps  cpu {frames / s['cpu_s']:7.1f} fps  "
            f"{s['bytes'] / 1024:8.0f} KB  coded {s['frames_coded']}/{s['frames_in']}")
    print(line)
    per = "  ".join(f"{k} {t[k] / max(1, len(fr)):6.2f}" for k in STAGES)
    print(f"{'':<28} ms/coded frame: {per}")
    if full:
        avg = {k: sum(f["ms"][k] for f in full) / len(full) for k in STAGES + ["total"]}
        print(f"{'':<28} full-change P ({len(full)}): " + "  ".join(f"{k} {avg[k]:6.2f}" for k in STAGES + ["total"]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--presets", default="live,fast,medium")
    ap.add_argument("--crf", type=float, default=26.0)
    ap.add_argument("--x264", default="veryfast")
    ap.add_argument("--x264-crf", type=float, default=23.0)
    ap.add_argument("--binary", default=str(ROOT / "build" / "capcodec-unchecked"))
    ap.add_argument("--extra", default="")
    ap.add_argument("--no-sideinfo", action="store_true")
    args = ap.parse_args()
    clips = {c.name: c for c in load_manifest()}
    for name in args.clips:
        src = prepare_source(clips[name], args.height, args.seconds)
        frames = src.frames
        print(f"== {name} {src.width}x{src.height} {frames} frames")
        for p in args.presets.split(","):
            s = run_capcodec(args.binary, src, p, args.crf, args.extra.split() if args.extra else [], frames,
                             not args.no_sideinfo)
            report(f"capcodec-{p}", s, frames)
        if args.x264:
            for threads in (1, 0):
                x = run_x264(src, args.x264, args.x264_crf, threads, frames)
                label = f"x264-{args.x264} t{threads or 'auto'}"
                print(f"{label:<28} wall {frames / x['wall_s']:7.1f} fps  cpu {frames / x['cpu_s']:7.1f} fps  "
                      f"{x['bytes'] / 1024:8.0f} KB")


if __name__ == "__main__":
    main()
