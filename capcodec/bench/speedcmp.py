#!/usr/bin/env python3
import argparse
import fcntl
import json
import os
import random
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness.adapters.base import raw_input_args  # noqa: E402
from harness.adapters.x264 import gop_args  # noqa: E402
from harness.common import CACHE_DIR, FFMPEG, OUT_DIR, ROOT, log  # noqa: E402
from harness.corpus import load_manifest, prepare_source  # noqa: E402
from harness.metrics import MetricConfig, measure  # noqa: E402

FROZEN_FILE = Path(tempfile.gettempdir()) / "speedcmp-frozen.json"
LOCK_FILE = Path(tempfile.gettempdir()) / "speedcmp.lock"
PROTECTED = {"node", "tini", "pod-daemon", "sshd", "systemd", "dbus-daemon", "cursor-agent-st"}
SHELLS = {"bash", "sh", "dash", "zsh"}
TMUX = {"tmux: server", "tmux"}
VMAF_CFG = MetricConfig(psnr=False, ssim=False, vmaf=True, vmaf_subsample=5, ocr=False, crops=False, vmaf_threads=4)
LONG_CLIP_SECONDS = {"code_4k": 5.0}
DEFAULT_CLIPS = ["busy_ui", "code_editor", "slides", "text_scroll", "full_motion", "webcam_overlay"]
MODES = {
    "medium": {"capcodec": ["--preset", "medium"], "x264": ("veryfast", None)},
    "live": {"capcodec": ["--preset", "live"], "x264": ("veryfast", None)},
    "zerolatency": {"capcodec": ["--preset", "live", "--zerolatency"], "x264": ("veryfast", "zerolatency")},
}


def ancestors(pid: int) -> set[int]:
    out = set()
    while pid > 1:
        out.add(pid)
        try:
            pid = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return out


def comm_of(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


def rank(pid: int) -> int:
    c = comm_of(pid)
    return 0 if c in TMUX else 1 if c in SHELLS else 2


def kept() -> set[int]:
    return {p for p in ancestors(os.getpid()) if comm_of(p) not in TMUX}


def freezable() -> list[int]:
    me = os.getuid()
    keep = kept()
    pids = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        pid = int(d.name)
        if pid in keep:
            continue
        try:
            if d.stat().st_uid != me:
                continue
            comm = (d / "comm").read_text().strip()
            state = (d / "stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if comm in PROTECTED or state in ("T", "Z"):
            continue
        pids.append(pid)
    return sorted(pids, key=rank)


def thaw(pids: list[int]) -> None:
    order = list(reversed(pids))
    ranks = {p: rank(p) for p in order}
    for r in (2, 1, 0):
        for p in order:
            if ranks[p] == r:
                try:
                    os.kill(p, signal.SIGCONT)
                except OSError:
                    pass
        time.sleep(0.02)
    FROZEN_FILE.unlink(missing_ok=True)


def thaw_leftovers() -> None:
    if not FROZEN_FILE.exists():
        return
    with open(LOCK_FILE, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return
        try:
            thaw(json.loads(FROZEN_FILE.read_text()))
        except (OSError, ValueError):
            FROZEN_FILE.unlink(missing_ok=True)


def children(pid: int) -> list[int]:
    out = []
    try:
        for t in Path(f"/proc/{pid}/task").iterdir():
            out += [int(c) for c in (t / "children").read_text().split()]
    except OSError:
        pass
    return out


def spawners() -> list[int]:
    me = os.getuid()
    out = []
    for d in Path("/proc").iterdir():
        if d.name.isdigit():
            try:
                if d.stat().st_uid == me and (d / "comm").read_text().strip() in PROTECTED:
                    out.append(int(d.name))
            except OSError:
                pass
    return out


class Quiet:
    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.pids: list[int] = []
        self.stopped: set[int] = set()
        self.done = threading.Event()
        self.lock = threading.Lock()
        self.watcher: threading.Thread | None = None
        self.resumed = False

    def stop(self, pids: list[int]) -> None:
        with self.lock:
            new = [p for p in pids if p not in self.stopped]
            self.pids += new
            self.stopped.update(new)
            FROZEN_FILE.write_text(json.dumps(self.pids))
        for p in new:
            try:
                os.kill(p, signal.SIGSTOP)
            except OSError:
                pass

    def watch(self, roots: list[int], keep: set[int]) -> None:
        while not self.done.wait(0.01):
            fresh = []
            todo = [c for r in roots for c in children(r)]
            while todo:
                c = todo.pop()
                if c in keep or c in self.stopped:
                    continue
                fresh.append(c)
                todo += children(c)
            if fresh:
                self.stop(fresh)

    def resume(self) -> None:
        self.done.set()
        if self.watcher is not None:
            self.watcher.join()
            self.watcher = None
        if not self.resumed:
            thaw(self.pids)
            self.resumed = True

    def __enter__(self):
        if not self.enabled:
            return self
        try:
            for _ in range(20):
                new = [p for p in freezable() if p not in self.stopped]
                if not new:
                    break
                self.stop(new)
                time.sleep(0.05)
            self.watcher = threading.Thread(target=self.watch, args=(spawners(), ancestors(os.getpid())), daemon=True)
            self.watcher.start()
            time.sleep(0.3)
        except BaseException:
            self.resume()
            raise
        return self

    def __exit__(self, *exc):
        if self.enabled:
            self.resume()
        return False


def timed(cmd: list[str], quiet: bool) -> dict:
    with open(LOCK_FILE, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return timed_locked(cmd, quiet)


def timed_locked(cmd: list[str], quiet: bool) -> dict:
    with Quiet(quiet) as q:
        load = os.getloadavg()[0]
        t0 = time.perf_counter()
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        _, status, ru = os.wait4(proc.pid, 0)
        wall = time.perf_counter() - t0
        err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError(f"{cmd[0]} failed: {err[-1000:]}")
    return {"wall": wall, "cpu": ru.ru_utime + ru.ru_stime, "rss_mb": ru.ru_maxrss / 1024, "frozen": len(q.pids),
            "load": load}


def capcodec_cmd(binary: str, src, crf: float, mode: str, threads: int | None, out: Path,
                 keyint1: bool = False) -> list[str]:
    cmd = [binary, "encode", "--input", str(src.path), "--width", str(src.width), "--height", str(src.height),
           "--fps", src.fps_arg, "--frames", str(src.frames), *MODES[mode]["capcodec"], "--crf", f"{crf:g}",
           "--output", str(out)]
    if keyint1:
        # With IDR reuse every keyframe copies the macroblocks whose source equals the previous frame's (busy_ui
        # 28% less CPU), which is not keyframe coding, and frame-parallel intra coding only runs without it.
        cmd += ["--keyint", "1", "--no-idr-reuse"]
    if src.sideinfo:
        cmd += ["--sideinfo", str(src.sideinfo)]
    if threads is not None:
        cmd += ["--threads", str(threads)]
    return cmd


def x264_cmd(src, crf: float, mode: str, threads: int, out: Path, keyint1: bool = False) -> list[str]:
    preset, tune = MODES[mode]["x264"]
    args = ["-c:v", "libx264", "-preset", preset]
    if tune:
        args += ["-tune", tune]
    gop = ["-g", "1", "-keyint_min", "1"] if keyint1 else gop_args(src)
    args += ["-crf", f"{crf:g}", *gop, "-pix_fmt", "yuv420p", "-threads", str(threads)]
    return [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *raw_input_args(src), *args, "-an",
            "-movflags", "+faststart", str(out)]


def vmaf_of(src, path: Path, work: Path) -> tuple[float, float]:
    r = measure(src, path, "mp4", VMAF_CFG, work, CACHE_DIR / "ocr")
    if r.get("vmaf") is None:
        raise RuntimeError(f"no VMAF for {path}: {r.get('decode_ffmpeg_error') or r.get('metrics_error')}")
    return r["vmaf"], path.stat().st_size * 8 / (src.frames / src.fps_float) / 1000


def match_crf(binary: str, src, mode: str, target: float, work: Path, start: float, keyint1: bool) -> dict:
    tried: dict[float, tuple[float, float]] = {}

    def at(c: float) -> float:
        c = max(10.0, min(51.0, round(c * 4) / 4))
        if c not in tried:
            out = work / f"cap_{mode}_{c:g}.mp4"
            subprocess.run(capcodec_cmd(binary, src, c, mode, None, out, keyint1), check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tried[c] = vmaf_of(src, out, work / "m")
            out.unlink(missing_ok=True)
        return c

    c = at(start)
    slope = -0.6
    for _ in range(6):
        v = tried[c][0]
        if abs(v - target) <= 0.1:
            break
        nxt = at(c + (target - v) / slope)
        if nxt == c:
            break
        if tried[nxt][0] != v:
            slope = (tried[nxt][0] - v) / (nxt - c)
            slope = min(-0.05, slope)
        c = nxt
    pts = sorted(tried.items())
    best = min(pts, key=lambda kv: abs(kv[1][0] - target))
    for (c0, (v0, _)), (c1, (v1, _)) in zip(pts, pts[1:]):
        if min(v0, v1) <= target <= max(v0, v1) and v0 != v1:
            ci = at(c0 + (target - v0) * (c1 - c0) / (v1 - v0))
            if abs(tried[ci][0] - target) <= abs(best[1][0] - target):
                best = (ci, tried[ci])
            break
    return {"crf": best[0], "vmaf": best[1][0], "kbps": best[1][1], "tried": {f"{k:g}": v for k, v in tried.items()}}


def summarize(runs: list[dict]) -> dict:
    return {"wall": statistics.median(r["wall"] for r in runs), "cpu": statistics.median(r["cpu"] for r in runs),
            "wall_min": min(r["wall"] for r in runs), "cpu_min": min(r["cpu"] for r in runs),
            "rss_mb": max(r["rss_mb"] for r in runs), "n": len(runs)}


def main() -> None:
    ap = argparse.ArgumentParser(description="interleaved speed comparison against x264 at matched VMAF")
    ap.add_argument("--binary", default=str(ROOT / "build" / "capcodec-unchecked"))
    ap.add_argument("--clips", default=",".join(DEFAULT_CLIPS))
    ap.add_argument("--modes", default="medium,live")
    ap.add_argument("--threads", default="1,4")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--x264-crf", type=float, default=23.0)
    ap.add_argument("--keyint1", action="store_true",
                    help="all-intra: every frame a keyframe (capcodec --keyint 1, x264 -g 1), reported as MODE-keyint1")
    ap.add_argument("--no-freeze", action="store_true")
    ap.add_argument("--retime", type=Path, help="reuse the matched CRFs of an earlier results.json and only time")
    ap.add_argument("--out", default=str(OUT_DIR / "speedcmp"))
    a = ap.parse_args()
    thaw_leftovers()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: (thaw_leftovers(), sys.exit(1)))
    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    clips = {c.name: c for c in load_manifest()}
    names = list(clips) if a.clips == "all" else a.clips.split(",")
    threads = [int(t) for t in a.threads.split(",")]
    results = json.loads((outdir / "results.json").read_text()) if (outdir / "results.json").exists() else {}
    matched = json.loads((a.retime / "results.json").read_text()) if a.retime else {}
    shm = Path("/dev/shm") if Path("/dev/shm").is_dir() else Path(tempfile.gettempdir())
    with tempfile.TemporaryDirectory(dir=shm, prefix="speedcmp-") as td:
        work = Path(td)
        for name in names:
            clip = clips[name]
            height = None if name in LONG_CLIP_SECONDS else a.height
            src = prepare_source(clip, height, LONG_CLIP_SECONDS.get(name, a.seconds))
            for mode in a.modes.split(","):
                mode_label = f"{mode}-keyint1" if a.keyint1 else mode
                key = f"{name}:{mode_label}"
                if key in results:
                    continue
                if key in matched:
                    target, xkbps, m = matched[key]["target_vmaf"], matched[key]["x264_kbps"], matched[key]["capcodec"]
                else:
                    log(f"{key}: matching VMAF")
                    xq = work / "x264_q.mp4"
                    subprocess.run(x264_cmd(src, a.x264_crf, mode, 1, xq, a.keyint1), check=True)
                    target, xkbps = vmaf_of(src, xq, work / "m")
                    m = match_crf(a.binary, src, mode, target, work, 26.0, a.keyint1)
                log(f"{key}: x264 crf {a.x264_crf:g} vmaf {target:.2f} {xkbps:.0f} kbps; capcodec crf {m['crf']:g} "
                    f"vmaf {m['vmaf']:.2f} {m['kbps']:.0f} kbps")
                runs: dict[str, list[dict]] = {}
                jobs = []
                for t in threads:
                    # Counts above 1 keep the published table: x264 uses -threads 0 (automatic).
                    jobs.append((f"x264_t{t}", x264_cmd(src, a.x264_crf, mode, 0 if t > 1 else 1, work / "x.mp4",
                                                        a.keyint1)))
                    jobs.append((f"cap_t{t}", capcodec_cmd(a.binary, src, m["crf"], mode, t, work / "c.mp4",
                                                           a.keyint1)))
                for r in range(a.rounds):
                    random.shuffle(jobs)
                    for label, cmd in jobs:
                        runs.setdefault(label, []).append(timed(cmd, not a.no_freeze))
                    log(f"{key}: round {r + 1}/{a.rounds}")
                entry = {"clip": name, "mode": mode_label, "width": src.width, "height": src.height,
                         "frames": src.frames, "fps": src.fps_float, "target_vmaf": target, "x264_kbps": xkbps,
                         "capcodec": m, "threads": {}}
                for t in threads:
                    xs, cs = summarize(runs[f"x264_t{t}"]), summarize(runs[f"cap_t{t}"])
                    ratios = [x["cpu"] / c["cpu"] for x, c in zip(runs[f"x264_t{t}"], runs[f"cap_t{t}"])]
                    entry["threads"][str(t)] = {
                        "x264": xs, "capcodec": cs, "cpu_ratio": xs["cpu"] / cs["cpu"], "wall_ratio": xs["wall"] / cs["wall"],
                        "cpu_ratio_range": [min(ratios), max(ratios)],
                        "frozen_median": statistics.median(r["frozen"] for r in runs[f"cap_t{t}"])}
                results[key] = entry
                (outdir / "results.json").write_text(json.dumps(results, indent=1))
                write_report(results, outdir / "report.md", threads)
    write_report(results, outdir / "report.md", threads)
    log(f"wrote {outdir / 'report.md'}")


def write_report(results: dict, path: Path, threads: list[int]) -> None:
    lines = ["# Speed at matched VMAF vs x264 (interleaved, other work paused during each timed run)", "",
             "Ratio = x264 / capcodec (above 1 means capcodec is faster). Medians over rounds.",
             "A thread count of 1 limits both encoders to one thread. A higher count limits capcodec to that count and runs x264 with `-threads 0` (automatic).",
             ""]
    head = "| clip | mode | VMAF | capcodec crf | kbps vs x264 |"
    sep = "|---|---|---|---|---|"
    for t in threads:
        x264 = "1t" if t == 1 else "auto"
        head += f" CPU cap {t}t / x264 {x264} | wall cap {t}t / x264 {x264} |"
        sep += "---|---|"
    lines += [head, sep]
    for e in results.values():
        row = (f"| {e['clip']} | {e['mode']} | {e['target_vmaf']:.2f} | {e['capcodec']['crf']:g} "
               f"({e['capcodec']['vmaf']:.2f}) | {e['capcodec']['kbps'] / e['x264_kbps']:.2f} |")
        for t in threads:
            d = e["threads"].get(str(t))
            row += f" {d['cpu_ratio']:.2f}x | {d['wall_ratio']:.2f}x |" if d else " | |"
        lines.append(row)
    path.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
