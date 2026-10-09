import os
import math
import platform
import shutil
import statistics
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

from . import bdrate
from .adapters import registry
from .adapters.base import Adapter, Point
from .common import CACHE_DIR, Cache, key_of, log, ncores
from .corpus import Source, load_manifest, prepare_source
from .metrics import MetricConfig, jm_check, measure, recon_md5, save_source_crops

SPEED_REPS = int(os.environ.get("CAPCODEC_SPEED_REPS", "3"))

REFERENCE = "x264-veryfast"
REFERENCE_POINT = "crf23"
GATE_ENCODER = "capcodec-medium"
JM_VERSION = "jm19.1-v3"
STAGES = ["analysis", "motion", "mode", "tq", "entropy", "deblock"]
PROPORTIONALITY_CLIPS = ["idle", "slow_typing"]


@dataclass
class Tier:
    name: str
    clips: list[str] | None
    max_height: int | None
    max_seconds: float | None
    metrics: MetricConfig
    encoders: list[str] | None
    jm_families: list[str]
    speed: bool
    speed_clips: list[str]
    playback: bool
    gate: bool
    quality_keys: list[str] = field(default_factory=lambda: ["psnr_yuv"])
    matched_key: str | None = None
    proportionality: bool = False


TIERS = {
    "smoke": Tier("smoke", ["code_editor", "text_scroll", "slides"], 720, 4.0,
                  MetricConfig(psnr=True, ssim=True, vmaf=False, crops=False),
                  ["capcodec-medium", "x264-veryfast"], ["capcodec"], False, [], False, True, ["psnr_yuv"]),
    "standard": Tier("standard", None, 1080, 10.0,
                     MetricConfig(psnr=True, ssim=True, vmaf=True, vmaf_subsample=5, crops=True),
                     None, ["capcodec"], True, ["code_editor", "busy_ui", "webcam_overlay"], False, False,
                     ["psnr_yuv", "vmaf", "ssim"], "vmaf", True),
    "ocr": Tier("ocr", ["code_editor", "slow_typing", "text_scroll", "busy_ui"], 1080, 10.0,
                MetricConfig(psnr=True, ssim=False, vmaf=True, vmaf_subsample=5, ocr=True, ocr_frames=3, crops=False),
                None, ["capcodec"], False, [], False, False, ["psnr_yuv", "vmaf"], None, False),
    "full": Tier("full", None, None, None,
                 MetricConfig(psnr=True, ssim=True, vmaf=True, vmaf_subsample=1, ocr=True, ocr_frames=6, crops=True),
                 None, ["*"], True, ["code_editor", "busy_ui", "webcam_overlay", "busy_ui_60fps", "code_4k"], True,
                 False, ["psnr_yuv", "vmaf", "ssim"], "vmaf", True),
}


class WeightedSlots:
    def __init__(self, total: int):
        self.total = total
        self.used = 0
        self.cv = threading.Condition()

    def acquire(self, w: int):
        w = max(1, min(w, self.total))
        with self.cv:
            while self.used + w > self.total:
                self.cv.wait()
            self.used += w
        return w

    def release(self, w: int):
        with self.cv:
            self.used -= w
            self.cv.notify_all()


def machine_id() -> str:
    cpu = platform.processor() or ""
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    return f"{platform.node()}|{platform.system()}|{cpu}|{ncores()}"


@dataclass
class Job:
    adapter: Adapter
    src: Source
    point: Point
    key: str


class Bench:
    def __init__(self, tier: Tier, cache: Cache, out_dir: Path, encoders: list[str] | None, clips: list[str] | None,
                 jobs: int, manifest: Path | None = None):
        self.tier = tier
        self.cache = cache
        self.out_dir = out_dir
        self.jobs = jobs
        self.slots = WeightedSlots(jobs)
        all_adapters = registry()
        wanted = encoders or tier.encoders
        self.unavailable: dict[str, str] = {}
        self.adapters: list[Adapter] = []
        for a in all_adapters:
            if wanted and a.name not in wanted and not any(w.endswith("*") and a.name.startswith(w[:-1]) for w in wanted):
                continue
            ok, why = a.available()
            if ok:
                self.adapters.append(a)
            else:
                self.unavailable[a.name] = why
        clips_all = load_manifest(manifest) if manifest else load_manifest()
        want_clips = clips or tier.clips
        self.clips = [c for c in clips_all if c.available and (not want_clips or c.name in want_clips)]
        if not self.clips and want_clips:
            self.clips = [c for c in clips_all if c.available][: len(want_clips)]
        self.rows: list[dict] = []
        self.lock = threading.Lock()
        self.anchor: dict[str, float] = {}

    def sources(self) -> list[Source]:
        out = []
        for c in self.clips:
            out.append(prepare_source(c, self.tier.max_height, self.tier.max_seconds))
        return out

    def points_for(self, a: Adapter, src: Source) -> list[Point]:
        try:
            return a.points(self.tier.name, src, anchor_kbps=self.anchor.get(src.id))
        except TypeError:
            return a.points(self.tier.name, src)

    def run(self) -> list[dict]:
        t0 = time.time()
        srcs = self.sources()
        crops_root = self.out_dir / "crops"
        if self.tier.metrics.crops:
            for s in srcs:
                save_source_crops(s, crops_root / s.name / "source")
        ref = [a for a in self.adapters if a.name == REFERENCE]
        rest = [a for a in self.adapters if a.name != REFERENCE]
        if ref:
            self._run_jobs([self._job(ref[0], s, p) for s in srcs for p in self.points_for(ref[0], s)])
            for s in srcs:
                for r in self.rows:
                    if r["encoder"] == REFERENCE and r["source_id"] == s.id and r["point"] == "crf23" and r.get("kbps"):
                        self.anchor[s.id] = r["kbps"]
        self._run_jobs([self._job(a, s, p) for a in rest for s in srcs for p in self.points_for(a, s)])
        if self.tier.speed:
            self._speed_runs(srcs)
        if self.tier.matched_key:
            self._matched_speed(srcs, self.tier.matched_key)
        if self.tier.proportionality:
            self._proportionality(srcs)
        log(f"{self.tier.name}: {len(self.rows)} encodes in {time.time() - t0:.1f}s")
        return self.rows

    def _speed(self, a: Adapter, s: Source, p: Point, tag: str = "") -> dict | None:
        key = key_of("speed", a.identity(), p.params, s.id, machine_id(), tag, SPEED_REPS)
        res = self.cache.get_json("speed", key)
        if res is None:
            d = self.cache.dir("speed", key)
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True)
            w = self.slots.acquire(self.jobs)
            try:
                log(f"speed {a.name} {s.name} {p.label} {tag}")
                out = None
                for _ in range(SPEED_REPS):
                    o = a.encode(s, p, d, speed=True)
                    if o.error is not None:
                        out = o
                        break
                    if out is None or o.run.wall_s < out.run.wall_s:
                        out = o
            finally:
                self.slots.release(w)
            res = {"wall_s": out.run.wall_s, "cpu_s": out.run.cpu_s, "maxrss_mb": out.run.maxrss_mb,
                   "error": out.error, "frames": s.frames, "stats": (out.extra or {}).get("stats"), "reps": SPEED_REPS}
            for f in d.iterdir():
                if f.name != "result.json":
                    f.unlink(missing_ok=True) if f.is_file() else shutil.rmtree(f, ignore_errors=True)
            if out.error is None:
                self.cache.put_json("speed", key, res)
        if res.get("error"):
            log(f"speed run failed: {a.name} {s.name} {p.label}: {str(res['error'])[-300:]}")
            return None
        return res

    def _quality_row(self, enc: str, clip: str, point: str) -> dict | None:
        for r in self.rows:
            if r["encoder"] == enc and r["clip"] == clip and r["point"] == point and r.get("kind") != "speed" \
                    and not r.get("error"):
                return r
        return None

    def _matched_speed(self, srcs: list[Source], qkey: str):
        ref_adapter = next((a for a in self.adapters if a.name == REFERENCE), None)
        if ref_adapter is None:
            return
        for s in srcs:
            ref_row = self._quality_row(REFERENCE, s.name, REFERENCE_POINT)
            if not ref_row or ref_row.get(qkey) is None:
                continue
            target = ref_row[qkey]
            ref_point = next(p for p in self.points_for(ref_adapter, s) if p.label == REFERENCE_POINT)
            ref_speed = self._speed(ref_adapter, s, ref_point, "matched")
            if not ref_speed:
                continue
            for a in self.adapters:
                if a.family != "capcodec":
                    continue
                curve = []
                pkey = "qp"
                for r in self.rows:
                    params = r.get("params") or {}
                    if r["encoder"] == a.name and r["clip"] == s.name and not r.get("kind") \
                            and r.get(qkey) is not None and ("qp" in params or "crf" in params):
                        pkey = "crf" if "crf" in params else "qp"
                        curve.append((params[pkey], r[qkey]))
                if len(curve) < 2:
                    continue
                curve.sort()
                qp = matched_qp(curve, target)
                if qp is None:
                    continue
                point = Point(f"{pkey}{qp}", {pkey: qp})
                job = self._job(a, s, point)
                row = self._quality_row(a.name, s.name, point.label)
                if row is None:
                    row = self._do_job(job)
                    with self.lock:
                        self.rows.append(row)
                if row.get(qkey) is None:
                    continue
                sp = self._speed(a, s, point, "matched")
                if not sp:
                    continue
                self.rows.append({
                    "tier": self.tier.name, "kind": "matched", "clip": s.name, "source_id": s.id, "encoder": a.name,
                    "family": a.family, "point": point.label, "width": s.width, "height": s.height,
                    "fps": s.fps_float, "frames": s.frames, "match_key": qkey, "target": target,
                    "achieved": row[qkey], "ref_kbps": ref_row["kbps"], "kbps": row["kbps"],
                    "ref_wall_fps": s.frames / ref_speed["wall_s"], "wall_fps": s.frames / sp["wall_s"],
                    "ref_cpu_fps": ref_row.get("cpu_fps"), "cpu_fps": row.get("cpu_fps"),
                    "speedup_wall": ref_speed["wall_s"] / sp["wall_s"],
                    "speedup_cpu": (row["cpu_fps"] / ref_row["cpu_fps"]) if row.get("cpu_fps") and ref_row.get("cpu_fps") else None,
                    "bitrate_ratio": row["kbps"] / ref_row["kbps"] if ref_row.get("kbps") else None})

    def _proportionality(self, srcs: list[Source]):
        for s in srcs:
            for a in self.adapters:
                if a.family != "capcodec" or a.name != GATE_ENCODER:
                    continue
                variants = [("normal", {"crf": 28, "threads": 1})]
                if s.name in PROPORTIONALITY_CLIPS or "idle" in s.name or "typing" in s.name:
                    variants += [("full_analysis", {"crf": 28, "threads": 1, "full-analysis": True}),
                                 ("pixel_fallback", {"crf": 28, "threads": 1, "no-sideinfo": True})]
                out = {}
                for tag, params in variants:
                    sp = self._speed(a, s, Point(f"crf28-{tag}", params), "prop")
                    if sp and sp.get("stats"):
                        out[tag] = proportionality_stats(sp["stats"])
                if not out.get("normal"):
                    continue
                row = {"tier": self.tier.name, "kind": "proportionality", "clip": s.name, "source_id": s.id,
                       "encoder": a.name, "family": a.family, "point": "crf28", "width": s.width,
                       "height": s.height, "fps": s.fps_float, "frames": s.frames, **{f"prop_{k}": v for k, v in
                                                                                         out["normal"].items()}}
                if out.get("full_analysis"):
                    full = out["full_analysis"].get("p_frame_ms_median")
                    row["prop_full_p_frame_ms"] = full
                    static = out["normal"].get("static_frame_ms_mean")
                    if full and static is not None:
                        row["prop_static_vs_full"] = static / full
                if out.get("pixel_fallback"):
                    fb = out["pixel_fallback"]
                    row["prop_fallback_static_frame_ms"] = fb.get("static_frame_ms_mean")
                    if row.get("prop_full_p_frame_ms") and fb.get("static_frame_ms_mean") is not None:
                        row["prop_fallback_static_vs_full"] = fb["static_frame_ms_mean"] / row["prop_full_p_frame_ms"]
                self.rows.append(row)

    def _job(self, a: Adapter, src: Source, p: Point) -> Job:
        return Job(a, src, p, key_of("encode", a.identity(), p.params, src.id))

    def _run_jobs(self, jobs: list[Job]):
        if not jobs:
            return
        with ThreadPoolExecutor(max_workers=self.jobs) as ex:
            futs = {ex.submit(self._do_job, j): j for j in jobs}
            for f in as_completed(futs):
                j = futs[f]
                try:
                    row = f.result()
                except Exception:
                    row = self._base_row(j)
                    row["error"] = traceback.format_exc()[-2000:]
                with self.lock:
                    self.rows.append(row)

    def _base_row(self, j: Job) -> dict:
        return {"tier": self.tier.name, "clip": j.src.name, "source_id": j.src.id, "encoder": j.adapter.name,
                "family": j.adapter.family, "point": j.point.label, "params": j.point.params,
                "production": j.point.production or getattr(j.adapter, "production", False),
                "width": j.src.width, "height": j.src.height, "fps": j.src.fps_float, "frames": j.src.frames,
                "key": j.key}

    def _do_job(self, j: Job) -> dict:
        row = self._base_row(j)
        enc = self.cache.get_json("encode", j.key)
        enc_dir = self.cache.dir("encode", j.key)
        if enc and not (enc_dir / enc.get("file", "")).exists():
            enc = None
        if enc is None:
            w = self.slots.acquire(j.adapter.weight)
            try:
                if enc_dir.exists():
                    shutil.rmtree(enc_dir)
                enc_dir.mkdir(parents=True)
                log(f"encode {j.adapter.name} {j.src.name} {j.point.label}")
                out = j.adapter.encode(j.src, j.point, enc_dir)
            finally:
                self.slots.release(w)
            enc = {"file": out.file.name, "container": out.container, "returncode": out.run.returncode,
                   "wall_s": out.run.wall_s, "cpu_s": out.run.cpu_s, "maxrss_mb": out.run.maxrss_mb,
                   "error": out.error, "extra": out.extra, "time": time.time()}
            if out.file.exists():
                enc["bytes"] = out.file.stat().st_size
            if out.recon is not None and out.recon.exists():
                enc["recon_md5"] = recon_md5(j.src, out.recon)
                out.recon.unlink()
            frame_map = out.extra.get("stats", {}).get("frame_map") if out.extra else None
            if frame_map:
                enc["frame_map"] = frame_map
            if out.error is None:
                self.cache.put_json("encode", j.key, enc)
        row.update({k: enc.get(k) for k in ("container", "wall_s", "cpu_s", "maxrss_mb", "bytes", "error")})
        stats = (enc.get("extra") or {}).get("stats") or {}
        if stats:
            row.update(stage_columns(stats, j.src.frames))
        if enc.get("error"):
            return row
        nbytes = enc.get("bytes", 0)
        row["kbps"] = nbytes * 8.0 / 1000.0 / j.src.duration_s
        row["cpu_fps"] = j.src.frames / enc["cpu_s"] if enc.get("cpu_s") else None
        row["wall_fps"] = j.src.frames / enc["wall_s"] if enc.get("wall_s") else None
        mkey = key_of("metrics", j.key, self.tier.metrics.key())
        met = self.cache.get_json("metrics", mkey)
        if met is None:
            w = self.slots.acquire(1)
            try:
                crops_dir = self.out_dir / "crops" / j.src.name / f"{j.adapter.name}_{j.point.label}"
                met = measure(j.src, enc_dir / enc["file"], enc["container"], self.tier.metrics,
                              self.cache.dir("metrics", mkey), CACHE_DIR / "ocr", crops_dir,
                              enc.get("frame_map"))
            finally:
                self.slots.release(w)
            if "metrics_error" not in met:
                self.cache.put_json("metrics", mkey, met)
        row.update({k: v for k, v in met.items() if k not in ("decoded_md5",)})
        dec_md5 = met.get("decoded_md5") or []
        if enc.get("recon_md5") is not None:
            row["recon_match"] = enc["recon_md5"] == dec_md5
            if not row["recon_match"]:
                row["recon_mismatch_first"] = next(
                    (i for i, (a, b) in enumerate(zip(enc["recon_md5"], dec_md5)) if a != b),
                    min(len(enc["recon_md5"]), len(dec_md5)))
        fams = self.tier.jm_families
        if "*" in fams or j.adapter.family in fams:
            jkey = key_of("jm", j.key, JM_VERSION)
            jm = self.cache.get_json("jm", jkey)
            if jm is None:
                w = self.slots.acquire(1)
                try:
                    jm = jm_check(j.src, enc_dir / enc["file"], enc["container"], self.cache.dir("jm", jkey))
                finally:
                    self.slots.release(w)
                if jm.get("decode_jm_ok") is not None:
                    self.cache.put_json("jm", jkey, jm)
            row["decode_jm_ok"] = jm.get("decode_jm_ok")
            row["decode_jm_error"] = jm.get("decode_jm_error")
            if jm.get("jm_md5") is not None:
                row["jm_match"] = jm["jm_md5"] == dec_md5
        return row

    def _speed_runs(self, srcs: list[Source]):
        chosen = [s for s in srcs if s.name in self.tier.speed_clips] or srcs[:2]
        for a in self.adapters:
            if not a.speed_weight:
                continue
            for s in chosen:
                pts = self.points_for(a, s)
                prod = [p for p in pts if p.production]
                p = prod[0] if prod else pts[len(pts) // 2 - 1 if len(pts) % 2 == 0 else len(pts) // 2]
                res = self._speed(a, s, p)
                if not res:
                    continue
                row = {"tier": self.tier.name, "kind": "speed", "clip": s.name, "source_id": s.id,
                       "encoder": a.name, "family": a.family, "point": p.label,
                       "width": s.width, "height": s.height, "fps": s.fps_float, "frames": s.frames,
                       "speed_wall_fps": s.frames / res["wall_s"] if res["wall_s"] else None,
                       "speed_cpu_fps": s.frames / res["cpu_s"] if res["cpu_s"] else None,
                       "speed_threads_cpu": res["cpu_s"] / res["wall_s"] if res["wall_s"] else None,
                       "maxrss_mb": res["maxrss_mb"]}
                row.update(stage_columns(res.get("stats"), s.frames))
                self.rows.append(row)


def matched_qp(curve: list[tuple[int, float]], target: float) -> int | None:
    best = None
    for (q0, v0), (q1, v1) in zip(curve, curve[1:]):
        lo, hi = min(v0, v1), max(v0, v1)
        if lo <= target <= hi and v0 != v1:
            best = q0 + (target - v0) * (q1 - q0) / (v1 - v0)
            break
    if best is None:
        if target > max(v for _, v in curve):
            best = curve[0][0] - 2
        else:
            best = curve[-1][0] + 2
    q = int(best)
    return max(10, min(51, q))


def stage_columns(stats: dict | None, frames: int) -> dict:
    if not stats or not frames:
        return {}
    t = stats.get("time_ms") or {}
    out = {f"ms_{k}": t[k] / frames for k in STAGES if t.get(k) is not None}
    if t.get("total") is not None:
        out["ms_total"] = t["total"] / frames
    for k in ("frames_coded", "frames_dropped", "changed_mb_fraction"):
        if stats.get(k) is not None:
            out[k] = stats[k]
    return out


def proportionality_stats(stats: dict) -> dict:
    frames = stats.get("frames") or []
    mbs = stats.get("mbs") or 1
    pf = [f for f in frames if f.get("type") in ("P", "D")]
    xs = [f.get("changed_mbs", 0) / mbs for f in pf]
    ys = [f.get("ms", {}).get("total", 0.0) for f in pf]
    static = [y for x, y in zip(xs, ys) if x == 0]
    out = {"frames": len(frames), "static_frames": len(static),
           "static_frame_ms_mean": statistics.mean(static) if static else None,
           "p_frame_ms_median": statistics.median(ys) if ys else None,
           "changed_fraction_mean": statistics.mean(xs) if xs else None}
    if len(set(xs)) >= 2:
        mx, my = statistics.mean(xs), statistics.mean(ys)
        sxx = sum((x - mx) ** 2 for x in xs)
        slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
        out["fit_fixed_ms"] = my - slope * mx
        out["fit_full_frame_ms"] = my - slope * mx + slope
    return out


def quality_rows(rows: list[dict]) -> list[dict]:
    return [r for r in rows if not r.get("kind") and not r.get("error")]


def bd_table(rows: list[dict], refs: list[str], qkey: str) -> dict:
    rows = quality_rows(rows)
    by = {}
    for r in rows:
        by.setdefault((r["encoder"], r["clip"]), []).append(r)
    encoders = sorted({r["encoder"] for r in rows})
    clips = sorted({r["clip"] for r in rows})
    out = {}
    for ref in refs:
        for e in encoders:
            vals = {}
            for c in clips:
                R = by.get((ref, c), [])
                T = by.get((e, c), [])
                if not R or not T:
                    continue
                v = bdrate.bd_rate([r["kbps"] for r in R], [r.get(qkey) for r in R], [t["kbps"] for t in T],
                                   [t.get(qkey) for t in T])
                if v is not None:
                    vals[c] = v
            if vals:
                out[(e, ref)] = {"mean": statistics.mean(vals.values()), "clips": vals, "n": len(vals)}
    return out


def rate_at_quality(curve: list[tuple[float, float]], q: float) -> tuple[float | None, bool]:
    pts = sorted((qq, r) for r, qq in curve if r and qq is not None)
    clean = []
    for qq, r in pts:
        if clean and (qq <= clean[-1][0] or r <= clean[-1][1]):
            continue
        clean.append((qq, r))
    if len(clean) < 2:
        return None, False
    for (q0, r0), (q1, r1) in zip(clean, clean[1:]):
        if q0 <= q <= q1:
            t = (q - q0) / (q1 - q0)
            return math.exp(math.log(r0) + t * (math.log(r1) - math.log(r0))), True
    (q0, r0), (q1, r1) = (clean[0], clean[1]) if q < clean[0][0] else (clean[-2], clean[-1])
    t = (q - q0) / (q1 - q0)
    return math.exp(math.log(r0) + t * (math.log(r1) - math.log(r0))), False


def production_matches(rows: list[dict], qkey: str) -> dict:
    q = quality_rows(rows)
    prod = [r for r in q if r.get("production") and r.get(qkey) is not None]
    ours = sorted({r["encoder"] for r in q if r["family"] == "capcodec"})
    out = {}
    for e in ours:
        for pr in prod:
            curve = [(r["kbps"], r.get(qkey)) for r in q if r["encoder"] == e and r["clip"] == pr["clip"]]
            rate, inside = rate_at_quality(curve, pr[qkey])
            if rate is None:
                continue
            ent = out.setdefault(e, {}).setdefault(pr["encoder"], {})
            ent[pr["clip"]] = {"point": pr["point"], "quality": pr[qkey], "their_kbps": pr["kbps"], "our_kbps": rate,
                               "ratio": rate / pr["kbps"], "interpolated": inside,
                               "their_cpu_fps": pr.get("cpu_fps")}
    return out


def cap_target_matches(rows: list[dict]) -> dict:
    q = quality_rows(rows)
    theirs = [r for r in q if r["family"] == "cap" and "bpp" in (r.get("params") or {})]
    out = {}
    for o in q:
        target = (o.get("params") or {}).get("bitrate")
        if o["family"] != "capcodec" or not target or not o.get("kbps"):
            continue
        for t in theirs:
            if t["clip"] != o["clip"] or t["point"] != o["point"] or not t.get("kbps"):
                continue
            ent = {"target_kbps": target, "our_kbps": o["kbps"], "their_kbps": t["kbps"],
                   "our_err": o["kbps"] / target - 1.0, "their_err": t["kbps"] / target - 1.0}
            for k in ("vmaf", "psnr_yuv"):
                if o.get(k) is not None and t.get(k) is not None:
                    ent[k] = o[k]
                    ent[f"their_{k}"] = t[k]
                    ent[f"d_{k}"] = o[k] - t[k]
            if o.get("cpu_fps") and t.get("cpu_fps"):
                ent["cpu_speedup"] = o["cpu_fps"] / t["cpu_fps"]
            out.setdefault(o["encoder"], {}).setdefault(t["encoder"], {}).setdefault(o["clip"], {})[o["point"]] = ent
    return out


def cap_target_summary(per_clip: dict) -> dict:
    ents = [e for pts in per_clip.values() for e in pts.values()]
    s = {"n": len(ents), "our_abs_err_mean": statistics.mean(abs(e["our_err"]) for e in ents),
         "their_abs_err_mean": statistics.mean(abs(e["their_err"]) for e in ents),
         "our_over_max": max(e["our_err"] for e in ents), "their_over_max": max(e["their_err"] for e in ents)}
    for k in ("vmaf", "psnr_yuv"):
        d = [e[f"d_{k}"] for e in ents if e.get(f"d_{k}") is not None]
        if d:
            s[f"d_{k}_mean"] = statistics.mean(d)
    sp = [e["cpu_speedup"] for e in ents if e.get("cpu_speedup")]
    if sp:
        s["cpu_speedup_geomean"] = math.exp(statistics.mean(math.log(v) for v in sp))
    return s


def summarize(rows: list[dict], tier: Tier, refs: list[str]) -> dict:
    q = quality_rows(rows)
    encoders = sorted({r["encoder"] for r in rows})
    summary = {}
    tables = {k: bd_table(rows, refs, k) for k in tier.quality_keys}
    for e in encoders:
        er = [r for r in q if r["encoder"] == e]
        sr = [r for r in rows if r.get("kind") == "speed" and r["encoder"] == e]
        s = {
            "encodes": len(er),
            "cpu_fps_median": statistics.median([r["cpu_fps"] for r in er if r.get("cpu_fps")]) if any(r.get("cpu_fps") for r in er) else None,
            "speed_wall_fps_median": statistics.median([r["speed_wall_fps"] for r in sr if r.get("speed_wall_fps")]) if sr else None,
            "decode_failures": sum(1 for r in er if r.get("decode_ffmpeg_ok") is False or r.get("decode_jm_ok") is False
                                   or r.get("recon_match") is False or r.get("jm_match") is False),
            "errors": sum(1 for r in rows if r["encoder"] == e and r.get("error")),
        }
        for k, t in tables.items():
            for ref in refs:
                v = t.get((e, ref))
                if v:
                    s[f"bd_{k}_vs_{ref}"] = v["mean"]
                    s[f"bd_{k}_vs_{ref}_n"] = v["n"]
        mr = [r for r in rows if r.get("kind") == "matched" and r["encoder"] == e and r.get("speedup_wall")]
        if mr:
            s["matched_speedup_wall_geomean"] = math.exp(statistics.mean(math.log(r["speedup_wall"]) for r in mr))
            s["matched_speedup_wall_min"] = min(r["speedup_wall"] for r in mr)
            s["matched_speedup_clips"] = {r["clip"]: r["speedup_wall"] for r in mr}
            cpu = [r["speedup_cpu"] for r in mr if r.get("speedup_cpu")]
            if cpu:
                s["matched_speedup_cpu_geomean"] = math.exp(statistics.mean(math.log(v) for v in cpu))
        pr = [r for r in rows if r.get("kind") == "proportionality" and r["encoder"] == e]
        if pr:
            s["static_vs_full"] = {r["clip"]: r.get("prop_static_vs_full") for r in pr if r.get("prop_static_vs_full") is not None}
        summary[e] = s
    mkey = tier.matched_key or "psnr_yuv"
    prodm = production_matches(rows, mkey)
    for e, per in prodm.items():
        s = summary.setdefault(e, {})
        vs = {}
        for p, clips in per.items():
            ratios = [c["ratio"] for c in clips.values()]
            vs[p] = {"bitrate_ratio_geomean": math.exp(statistics.mean(math.log(x) for x in ratios)),
                     "clips": len(ratios), "interpolated": sum(1 for c in clips.values() if c["interpolated"])}
        s["vs_production"] = vs
    targets = cap_target_matches(rows)
    for e, per in targets.items():
        summary.setdefault(e, {})["vs_cap_targets"] = {surf: cap_target_summary(clips) for surf, clips in per.items()}
    return {"summary": summary, "tables": {k: {f"{e}|{r}": v for (e, r), v in t.items()} for k, t in tables.items()},
            "production": prodm, "production_key": mkey, "cap_targets": targets}


def gate(summary: dict, best: dict | None) -> tuple[bool, list[str]]:
    msgs = []
    ok = True
    s = summary.get(GATE_ENCODER)
    for e, v in summary.items():
        if v.get("decode_failures"):
            ok = False
            msgs.append(f"FAIL decode check: {e} has {v['decode_failures']} failing encodes")
        if v.get("errors"):
            ok = False
            msgs.append(f"FAIL {e}: {v['errors']} encodes errored")
    if s is None:
        msgs.append(f"{GATE_ENCODER} not run; gate checks decode only")
        return ok, msgs
    bd = s.get(f"bd_psnr_yuv_vs_{REFERENCE}")
    fps = s.get("cpu_fps_median")
    if best:
        b_bd, b_fps = best.get("bd_psnr_yuv"), best.get("cpu_fps")
        if bd is not None and b_bd is not None and bd > b_bd + 1.0:
            ok = False
            msgs.append(f"FAIL BD-rate regressed: {bd:+.2f}% vs best {b_bd:+.2f}% (limit +1.0)")
        if fps is not None and b_fps and fps < 0.9 * b_fps:
            ok = False
            msgs.append(f"FAIL speed regressed: {fps:.1f} cpu-fps vs best {b_fps:.1f} (limit -10%)")
    msgs.append(f"{GATE_ENCODER}: BD-rate(PSNR-YUV) vs {REFERENCE} = "
                f"{'n/a' if bd is None else f'{bd:+.2f}%'}, cpu-fps median = {'n/a' if fps is None else f'{fps:.1f}'}")
    return ok, msgs
