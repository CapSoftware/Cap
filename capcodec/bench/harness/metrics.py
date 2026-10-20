import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .common import FFMPEG, FFPROBE, LDECOD, TESSERACT, log, run
from .corpus import Source

METRICS_VERSION = "m5"
OCR_WORDS_VERSION = 1
OCR_WORD_MIN_CONF = 80.0
OCR_WORD_MIN_COVER = 0.5
OCR_STRIP = ".,;:!?()[]{}<>\"'`|"


@dataclass
class MetricConfig:
    psnr: bool = True
    ssim: bool = True
    vmaf: bool = False
    vmaf_subsample: int = 1
    ocr: bool = False
    ocr_frames: int = 4
    crops: bool = True
    vmaf_threads: int = 1

    def key(self) -> dict:
        k = {"v": METRICS_VERSION, "psnr": self.psnr, "ssim": self.ssim, "vmaf": self.vmaf,
             "vmaf_sub": self.vmaf_subsample if self.vmaf else 0, "ocr": self.ocr,
             "ocr_frames": self.ocr_frames if self.ocr else 0, "crops": self.crops}
        if self.ocr:
            k["ocr_words"] = OCR_WORDS_VERSION
        return k


def input_args(path: Path, container: str) -> list[str]:
    if container == "annexb":
        return ["-f", "h264", "-i", str(path)]
    return ["-i", str(path)]


def frame_times(path: Path, container: str) -> list[float] | None:
    if container == "annexb":
        return None
    r = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0",
             str(path)])
    times = []
    for line in r.stdout.decode().splitlines():
        line = line.strip().strip(",")
        if not line or line == "N/A":
            continue
        try:
            times.append(float(line))
        except ValueError:
            continue
    times.sort()
    return times or None


def cfr_map(n_source: int, fps: float, times: list[float] | None, n_decoded: int,
            frame_map: list[int] | None = None) -> list[int]:
    if frame_map:
        out, j = [], 0
        for k in range(n_source):
            while j + 1 < len(frame_map) and frame_map[j + 1] <= k:
                j += 1
            out.append(min(j, n_decoded - 1))
        return out
    if n_decoded == n_source or not times:
        return [min(k, n_decoded - 1) for k in range(n_source)]
    t0 = times[0]
    rel = [t - t0 for t in times[:n_decoded]]
    out, j = [], 0
    for k in range(n_source):
        t = k / fps + 0.5 / fps
        while j + 1 < len(rel) and rel[j + 1] <= t:
            j += 1
        out.append(j)
    return out


def parse_psnr(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines():
        d = dict(re.findall(r"(\w+):(\S+)", line))
        if "mse_y" in d:
            rows.append({k: float(d[k]) for k in ("mse_y", "mse_u", "mse_v") if k in d})
    return rows


def parse_ssim(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines():
        d = dict(re.findall(r"(\w+):(\S+)", line))
        if "All" in d:
            rows.append({"ssim_y": float(d.get("Y", "nan")), "ssim": float(d["All"])})
    return rows


def mse_to_psnr(mse: float) -> float:
    if mse <= 1e-10:
        return 100.0
    return min(100.0, 10.0 * math.log10(255.0 * 255.0 / mse))


def ocr_read(img: np.ndarray, workdir: Path, tag: str) -> tuple[str, list[list]]:
    from PIL import Image
    im = Image.fromarray(img).resize((img.shape[1] * 2, img.shape[0] * 2), Image.Resampling.BICUBIC)
    p = workdir / f"ocr_{tag}.png"
    base = workdir / f"ocr_{tag}"
    im.save(p)
    run([TESSERACT, str(p), str(base), "--psm", "6", "-l", "eng", "txt", "tsv"], env={"OMP_THREAD_LIMIT": "1"},
        timeout=300)
    txt_path, tsv_path = Path(f"{base}.txt"), Path(f"{base}.tsv")
    text = " ".join(txt_path.read_text(errors="replace").split()) if txt_path.exists() else ""
    words = parse_tsv_words(tsv_path.read_text(errors="replace")) if tsv_path.exists() else []
    for f in (p, txt_path, tsv_path):
        f.unlink(missing_ok=True)
    return text, words


def ocr_text(img: np.ndarray, workdir: Path, tag: str) -> str:
    return ocr_read(img, workdir, tag)[0]


def parse_tsv_words(tsv: str) -> list[list]:
    words = []
    for line in tsv.splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) < 12 or cols[0] != "5" or not cols[11].strip():
            continue
        words.append([cols[11].strip(), float(cols[10]), int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9])])
    return words


def ocr_reference_words(words: list[list]) -> list[list]:
    out = []
    for text, conf, x, y, w, h in words:
        t = text.strip(OCR_STRIP)
        alnum = sum(c.isalnum() for c in t)
        if conf >= OCR_WORD_MIN_CONF and alnum >= 2 and alnum * 5 >= len(t) * 3:
            out.append([t, x, y, w, h])
    return out


def ocr_word_errors(ref_words: list[list], got_words: list[list]) -> tuple[int, int]:
    errs, total = 0, 0
    for t, x, y, w, h in ref_words:
        parts = []
        for gt, _conf, gx, gy, gw, gh in got_words:
            ix = min(x + w, gx + gw) - max(x, gx)
            iy = min(y + h, gy + gh) - max(y, gy)
            if ix > 0 and iy > 0 and ix * iy >= OCR_WORD_MIN_COVER * min(w * h, gw * gh):
                parts.append((gx, gt.strip(OCR_STRIP)))
        got = "".join(p for _, p in sorted(parts))
        errs += min(substring_distance(t, got), len(t))
        total += len(t)
    return errs, total


def substring_distance(word: str, text: str) -> int:
    prev = [0] * (len(text) + 1)
    for i, cw in enumerate(word, 1):
        cur = [i] + [0] * len(text)
        for j, ct in enumerate(text, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (cw != ct))
        prev = cur
    return min(prev)


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1]


def read_frame(f, nbytes: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < nbytes:
        chunk = f.read(nbytes - len(buf))
        if not chunk:
            return None if not buf else bytes(buf)
        buf += chunk
    return bytes(buf)


def y_plane(frame: bytes, w: int, h: int) -> np.ndarray:
    return np.frombuffer(frame, dtype=np.uint8, count=w * h).reshape(h, w)


def to_rgb(frame: bytes, w: int, h: int) -> np.ndarray:
    y = np.frombuffer(frame, dtype=np.uint8, count=w * h).reshape(h, w).astype(np.float32)
    u = np.frombuffer(frame, dtype=np.uint8, count=w * h // 4, offset=w * h).reshape(h // 2, w // 2).astype(np.float32)
    v = np.frombuffer(frame, dtype=np.uint8, count=w * h // 4, offset=w * h * 5 // 4).reshape(h // 2, w // 2).astype(np.float32)
    u = u.repeat(2, 0).repeat(2, 1) - 128.0
    v = v.repeat(2, 0).repeat(2, 1) - 128.0
    yy = (y - 16.0) * (255.0 / 219.0)
    r = yy + 1.5748 * (255.0 / 224.0) * v
    g = yy - 0.1873 * (255.0 / 224.0) * u - 0.4681 * (255.0 / 224.0) * v
    b = yy + 1.8556 * (255.0 / 224.0) * u
    return np.clip(np.stack([r, g, b], -1), 0, 255).astype(np.uint8)


def crop_frames(src: Source) -> list[int]:
    return [src.frames // 2]


def ocr_frame_indices(src: Source, n: int) -> list[int]:
    if src.frames <= n:
        return list(range(src.frames))
    return [int((i + 0.5) * src.frames / n) for i in range(n)]


def source_ocr(src: Source, cfg: MetricConfig, cache_dir: Path) -> dict:
    p = cache_dir / f"ocr_{src.id}_{cfg.ocr_frames}.json"
    if p.exists():
        return json.loads(p.read_text())
    out = {}
    fb = src.frame_bytes
    with open(src.path, "rb") as f, tempfile.TemporaryDirectory() as td:
        for k in ocr_frame_indices(src, cfg.ocr_frames):
            f.seek(k * fb)
            frame = f.read(fb)
            y = y_plane(frame, src.width, src.height)
            for ri, (x, yy, w, h) in enumerate(src.text_regions):
                out[f"{k}:{ri}"] = ocr_text(np.ascontiguousarray(y[yy:yy + h, x:x + w]), Path(td), f"s{k}_{ri}")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    return out


def source_ocr_words(src: Source, cfg: MetricConfig, cache_dir: Path) -> dict:
    p = cache_dir / f"ocr_words{OCR_WORDS_VERSION}_{src.id}_{cfg.ocr_frames}.json"
    if p.exists():
        return json.loads(p.read_text())
    out = {}
    fb = src.frame_bytes
    with open(src.path, "rb") as f, tempfile.TemporaryDirectory() as td:
        for k in ocr_frame_indices(src, cfg.ocr_frames):
            f.seek(k * fb)
            frame = f.read(fb)
            y = y_plane(frame, src.width, src.height)
            for ri, (x, yy, w, h) in enumerate(src.text_regions):
                _, words = ocr_read(np.ascontiguousarray(y[yy:yy + h, x:x + w]), Path(td), f"w{k}_{ri}")
                out[f"{k}:{ri}"] = ocr_reference_words(words)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    return out


def measure(src: Source, enc_file: Path, container: str, cfg: MetricConfig, workdir: Path, cache_dir: Path,
            crops_dir: Path | None = None, frame_map: list[int] | None = None) -> dict:
    workdir.mkdir(parents=True, exist_ok=True)
    w, h, fb = src.width, src.height, src.frame_bytes
    times = frame_times(enc_file, container)
    dec_cmd = [FFMPEG, "-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect",
               "crccheck+bitstream+buffer+explode", "-threads", "1", *input_args(enc_file, container),
               "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]
    dec_err = workdir / "decode_stderr.txt"
    psnr_log, ssim_log, vmaf_log = workdir / "psnr.log", workdir / "ssim.log", workdir / "vmaf.json"
    n_out = int(cfg.psnr) + int(cfg.ssim) + int(cfg.vmaf)
    graph = None
    if n_out:
        da = "".join(f"[d{i}]" for i in range(n_out))
        ra = "".join(f"[r{i}]" for i in range(n_out))
        parts = [f"[0:v]split={n_out}{da}" if n_out > 1 else "[0:v]null[d0]",
                 f"[1:v]split={n_out}{ra}" if n_out > 1 else "[1:v]null[r0]"]
        i = 0
        if cfg.psnr:
            parts.append(f"[d{i}][r{i}]psnr=stats_file={psnr_log}")
            i += 1
        if cfg.ssim:
            parts.append(f"[d{i}][r{i}]ssim=stats_file={ssim_log}")
            i += 1
        if cfg.vmaf:
            parts.append(f"[d{i}][r{i}]libvmaf=log_fmt=json:log_path={vmaf_log}:n_subsample={cfg.vmaf_subsample}"
                         f":n_threads={cfg.vmaf_threads}")
        graph = ";".join(parts)
    met_cmd = [FFMPEG, "-hide_banner", "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s",
               f"{w}x{h}", "-r", src.fps_arg, "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s",
               f"{w}x{h}", "-r", src.fps_arg, "-i", str(src.path), "-lavfi", graph or "[0:v][1:v]psnr", "-f", "null",
               "-"]
    met_err = workdir / "metrics_stderr.txt"
    want_ocr = set(ocr_frame_indices(src, cfg.ocr_frames)) if cfg.ocr and src.text_regions else set()
    want_crop = set(crop_frames(src)) if cfg.crops and crops_dir else set()
    decoded_md5: list[str] = []
    ocr_crops: dict[str, np.ndarray] = {}
    if frame_map:
        n_expected = len(frame_map)
    elif times:
        n_expected = len(times)
    else:
        n_expected = src.frames
    mapping = cfr_map(src.frames, src.fps_float, times, n_expected, frame_map)
    with open(dec_err, "wb") as de, open(met_err, "wb") as me:
        dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=de, stdin=subprocess.DEVNULL)
        met = subprocess.Popen(met_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=me)
        cur: bytes | None = None
        cur_j = -1
        dec_done = False
        try:
            for k, j in enumerate(mapping):
                while cur_j < j and not dec_done:
                    fr = read_frame(dec.stdout, fb)
                    if fr is None or len(fr) != fb:
                        dec_done = True
                        break
                    decoded_md5.append(hashlib.md5(fr).hexdigest())
                    cur, cur_j = fr, cur_j + 1
                if cur is None:
                    break
                met.stdin.write(cur)
                if k in want_ocr:
                    y = y_plane(cur, w, h)
                    for ri, (x, yy, rw, rh) in enumerate(src.text_regions):
                        ocr_crops[f"{k}:{ri}"] = np.ascontiguousarray(y[yy:yy + rh, x:x + rw])
                if k in want_crop and crops_dir is not None and src.text_regions:
                    save_crop(cur, src, crops_dir / f"k{k}.png")
            met.stdin.close()
        except BrokenPipeError:
            pass
        while not dec_done:
            fr = read_frame(dec.stdout, fb)
            if fr is None or len(fr) != fb:
                break
            decoded_md5.append(hashlib.md5(fr).hexdigest())
        dec.wait()
        met.wait()
    n_dec = len(decoded_md5)
    result = {"frames_decoded": n_dec, "frames_source": src.frames, "frames_expected": n_expected,
              "decoded_md5": decoded_md5, "cfr_duplicated": src.frames - len(set(mapping))}
    dec_stderr = dec_err.read_text(errors="replace").strip()
    result["decode_ffmpeg_ok"] = dec.returncode == 0 and not dec_stderr and n_dec > 0 and n_dec == n_expected
    if dec_stderr:
        result["decode_ffmpeg_error"] = dec_stderr[-2000:]
    elif n_dec != n_expected:
        result["decode_ffmpeg_error"] = f"decoded {n_dec} frames, container has {n_expected}"
    else:
        result["decode_ffmpeg_error"] = ""
    if n_dec == 0:
        result["metrics_error"] = f"no frames decoded: {result['decode_ffmpeg_error'][-300:]}"
        return result
    if met.returncode != 0:
        result["metrics_error"] = (met_err.read_text(errors="replace")[-2000:]
                                   or f"metrics ffmpeg exit status {met.returncode}, no output")
        return result
    if cfg.psnr and psnr_log.exists():
        rows = parse_psnr(psnr_log)
        if rows:
            my = float(np.mean([r["mse_y"] for r in rows]))
            mu = float(np.mean([r["mse_u"] for r in rows]))
            mv = float(np.mean([r["mse_v"] for r in rows]))
            py, pu, pv = mse_to_psnr(my), mse_to_psnr(mu), mse_to_psnr(mv)
            result.update({"psnr_y": py, "psnr_u": pu, "psnr_v": pv, "psnr_yuv": (6 * py + pu + pv) / 8.0,
                           "psnr_y_framemean": float(np.mean([mse_to_psnr(r["mse_y"]) for r in rows])),
                           "psnr_y_min": float(min(mse_to_psnr(r["mse_y"]) for r in rows))})
    if cfg.ssim and ssim_log.exists():
        rows = parse_ssim(ssim_log)
        if rows:
            result["ssim"] = float(np.mean([r["ssim"] for r in rows]))
            result["ssim_y"] = float(np.mean([r["ssim_y"] for r in rows]))
            result["ssim_min"] = float(min(r["ssim"] for r in rows))
    if cfg.vmaf and vmaf_log.exists():
        v = json.loads(vmaf_log.read_text())
        scores = [fr["metrics"]["vmaf"] for fr in v.get("frames", []) if "vmaf" in fr.get("metrics", {})]
        if scores:
            result["vmaf"] = float(np.mean(scores))
            result["vmaf_min"] = float(min(scores))
            result["vmaf_p5"] = float(np.percentile(scores, 5))
            result["vmaf_frames"] = len(scores)
    if want_ocr:
        ref = source_ocr(src, cfg, cache_dir)
        ref_words = source_ocr_words(src, cfg, cache_dir)
        errs, total, werrs, wtotal = 0, 0, 0, 0
        with tempfile.TemporaryDirectory() as td:
            for key, img in ocr_crops.items():
                truth = ref.get(key, "")
                rw = ref_words.get(key, [])
                if not truth and not rw:
                    continue
                got, got_words = ocr_read(img, Path(td), key.replace(":", "_"))
                if truth:
                    errs += levenshtein(got, truth)
                    total += len(truth)
                e, n = ocr_word_errors(rw, got_words)
                werrs += e
                wtotal += n
        result["ocr_cer"] = errs / total if total else None
        result["ocr_chars"] = total
        result["ocr_word_cer"] = werrs / wtotal if wtotal else None
        result["ocr_word_chars"] = wtotal
    for p in (psnr_log, ssim_log, vmaf_log):
        p.unlink(missing_ok=True)
    return result


def save_crop(frame: bytes, src: Source, path: Path) -> None:
    from PIL import Image
    x, y, w, h = src.text_regions[0]
    w = min(w, 640)
    h = min(h, 360)
    rgb = to_rgb(frame, src.width, src.height)[y:y + h, x:x + w]
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(path)


def save_source_crops(src: Source, crops_dir: Path) -> None:
    fb = src.frame_bytes
    with open(src.path, "rb") as f:
        for k in crop_frames(src):
            out = crops_dir / f"k{k}.png"
            if out.exists() or not src.text_regions:
                continue
            f.seek(k * fb)
            save_crop(f.read(fb), src, out)


def annexb_for(enc_file: Path, container: str, workdir: Path) -> Path | None:
    if container == "annexb":
        return enc_file
    out = workdir / "stream.264"
    r = run([FFMPEG, "-hide_banner", "-v", "error", "-nostdin", "-y", "-i", str(enc_file), "-map", "0:v:0", "-c", "copy",
             "-bsf:v", "h264_mp4toannexb", "-f", "h264", str(out)])
    if r.returncode != 0:
        return None
    return out


def md5_frames(path: Path, fb: int) -> list[str]:
    out = []
    with open(path, "rb") as f:
        while True:
            fr = read_frame(f, fb)
            if fr is None or len(fr) != fb:
                break
            out.append(hashlib.md5(fr).hexdigest())
    return out


def jm_check(src: Source, enc_file: Path, container: str, workdir: Path) -> dict:
    if not shutil.which(LDECOD) and not Path(LDECOD).exists():
        return {"decode_jm_ok": None, "decode_jm_error": "JM ldecod not installed"}
    td = Path(tempfile.mkdtemp(dir=workdir.parent if workdir.parent.exists() else None))
    try:
        stream = annexb_for(enc_file, container, td)
        if stream is None:
            return {"decode_jm_ok": False, "decode_jm_error": "could not extract an Annex B stream"}
        out = td / "jm.yuv"
        r = run([LDECOD, "-p", f"InputFile={stream}", "-p", f"OutputFile={out}", "-p", "WriteUV=1"], cwd=td,
                timeout=3600)
        text = (r.stdout + r.stderr).decode(errors="replace")
        bad = [ln for ln in text.splitlines() if re.search(r"error|warning|unsupported|concealment", ln, re.I)]
        if r.returncode != 0 or not out.exists():
            return {"decode_jm_ok": False, "decode_jm_error": (bad or text.splitlines()[-5:])[-5:]}
        md5s = md5_frames(out, src.frame_bytes)
        return {"decode_jm_ok": not bad and len(md5s) > 0, "decode_jm_error": bad[-5:] if bad else "",
                "jm_md5": md5s}
    finally:
        shutil.rmtree(td, ignore_errors=True)


def recon_md5(src: Source, recon: Path) -> list[str]:
    return md5_frames(recon, src.frame_bytes)
