"""Map the frames of a captured video-playback clip back to source video frames.

Capture (GBR) and source (H.264 4:2:0) are both decoded by ffmpeg, area-downscaled
to 480x270 RGB and reduced to 8-bit luma. Chrome's YUV->RGB conversion is not
swscale's (matrix, range, chroma upsampling), which leaves a smooth, colour-
dependent bias of a few levels that is as large as the difference between
neighbouring frames, so frames are compared on high-passed luma (minus a 9x9 box
blur, 2x2-averaged to 240x135, normalised to zero mean and unit variance) with
distance 1 - normalised cross-correlation. Each captured frame i is compared with
source frames j = i + o for offsets o in a band, and a Viterbi pass picks the
mapping that minimises total distance plus OFFSET_PENALTY per unit change of o.
A repeated source frame shows up as j(i) == j(i-1), a skipped one as
j(i) > j(i-1) + 1.
"""

import collections
import json
import subprocess

import numpy as np

W, H = 480, 270
BLUR_RADIUS = 4
BAND = 6
OFFSET_PENALTY = 0.004


def luma_frames(ffmpeg, path, yuv_bt709=False, count=None):
    scale = f"scale={W}:{H}:flags=area" + (":in_color_matrix=bt709:in_range=tv" if yuv_bt709 else "")
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough"]
    if count is not None:
        cmd += ["-frames:v", str(count)]
    cmd += ["-vf", f"{scale},format=rgb24", "-f", "rawvideo", "-"]
    size = W * H * 3
    out = []
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            rgb = np.frombuffer(buf, dtype=np.uint8).reshape(H, W, 3).astype(np.uint16)
            out.append(((54 * rgb[..., 0] + 183 * rgb[..., 1] + 19 * rgb[..., 2] + 128) >> 8).astype(np.uint8))
    finally:
        proc.stdout.close()
        rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"ffmpeg decode of {path} failed with exit code {rc}")
    return np.stack(out) if out else np.zeros((0, H, W), dtype=np.uint8)


def _box(f, r):
    k = 2 * r + 1
    p = np.pad(f, r, mode="edge")
    c = np.concatenate([np.zeros((1, p.shape[1])), p.cumsum(axis=0)], axis=0)
    v = c[k:] - c[:-k]
    c = np.concatenate([np.zeros((v.shape[0], 1)), v.cumsum(axis=1)], axis=1)
    return (c[:, k:] - c[:, :-k]) / (k * k)


def features(luma):
    out = np.empty((len(luma), H // 2, W // 2), dtype=np.float32)
    for i, frame in enumerate(luma):
        f = frame.astype(np.float64)
        hp = (f - _box(f, BLUR_RADIUS)).reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
        hp -= hp.mean()
        out[i] = hp / max(float(hp.std()), 1e-6)
    return out


def _dist(a, b):
    return 1.0 - (a * b).mean(axis=(-2, -1))


def find_offset(cap, src, probe=range(8, 16)):
    idx = [i for i in probe if 0 <= i < len(cap)]
    span = max(idx) - min(idx)
    cost = np.zeros(len(src) - span)
    for i in idx:
        j = i - idx[0]
        cost += _dist(src[j : j + len(cost)], cap[i])
    return int(np.argmin(cost)) - idx[0]


def match(cap, src, offset):
    """Return (source index per captured frame, distance of the chosen match, distance of the best other offset)."""
    n = len(cap)
    offs = np.arange(offset - BAND, offset + BAND + 1)
    d = np.full((n, len(offs)), np.inf, dtype=np.float64)
    for i in range(n):
        lo, hi = i + offs[0], i + offs[-1] + 1
        a, b = max(lo, 0), min(hi, len(src))
        if b > a:
            d[i, a - lo : b - lo] = _dist(src[a:b], cap[i])
    k = len(offs)
    trans = OFFSET_PENALTY * np.abs(np.arange(k)[:, None] - np.arange(k)[None, :])
    cost = d[0].copy()
    back = np.zeros((n, k), dtype=np.int32)
    for i in range(1, n):
        tot = cost[:, None] + trans
        back[i] = np.argmin(tot, axis=0)
        cost = tot[back[i], np.arange(k)] + d[i]
    path = [int(np.argmin(cost))]
    for i in range(n - 1, 0, -1):
        path.append(int(back[i, path[-1]]))
    path.reverse()
    js = [int(i + offs[p]) for i, p in enumerate(path)]
    chosen = [float(d[i, p]) for i, p in enumerate(path)]
    other = [float(np.min(np.delete(d[i], p))) for i, p in enumerate(path)]
    return js, chosen, other


def summarize(js, chosen, other, first_expected=None):
    steps = [b - a for a, b in zip(js, js[1:])]
    events = [{"frame": i + 1, "source_step": s} for i, s in enumerate(steps) if s != 1]
    ratio = [o / max(c, 1e-6) for c, o in zip(chosen, other)]
    out = {
        "frames": len(js),
        "source_first": js[0],
        "source_last": js[-1],
        "source_steps": dict(sorted(collections.Counter(steps).items())),
        "repeated_frames": sum(s == 0 for s in steps),
        "skipped_source_frames": sum(s - 1 for s in steps if s > 1),
        "backward_steps": sum(s < 0 for s in steps),
        "irregular_steps": events[:40],
        "match_distance": {
            "median": round(float(np.median(chosen)), 4),
            "p99": round(float(np.percentile(chosen, 99)), 4),
            "max": round(float(np.max(chosen)), 4),
        },
        "next_best_distance_ratio": {
            "min": round(float(np.min(ratio)), 3),
            "p01": round(float(np.percentile(ratio, 1)), 3),
            "median": round(float(np.median(ratio)), 3),
        },
        "frames_with_next_best_ratio_below_2": int(sum(r < 2 for r in ratio)),
    }
    if first_expected is not None:
        out["source_first_expected"] = first_expected
        out["source_last_expected"] = first_expected + len(js) - 1
    return out


def video_frame_stats(events, t_first_ms, t_last_ms, fps):
    """Chrome-side presentation stats from requestVideoFrameCallback records between two wallclock instants."""
    vf = [e for e in events if e.get("k") == "page" and e.get("type") == "video_frame"]
    vf = [e for e in vf if t_first_ms - 1000.0 / fps <= e["expected_display"] <= t_last_ms]
    if len(vf) < 2:
        return {"callbacks": len(vf)}
    vsync = 1000.0 / 60
    media_steps = collections.Counter(round((b["media_time"] - a["media_time"]) * fps) for a, b in zip(vf, vf[1:]))
    presented = collections.Counter(b["presented_frames"] - a["presented_frames"] for a, b in zip(vf, vf[1:]))
    disp = [b["expected_display"] - a["expected_display"] for a, b in zip(vf, vf[1:])]
    disp_vsyncs = collections.Counter(round(x / vsync) for x in disp)
    return {
        "callbacks": len(vf),
        "media_time_steps_frames": {str(k): v for k, v in sorted(media_steps.items())},
        "presented_frames_steps": {str(k): v for k, v in sorted(presented.items())},
        "expected_display_interval_vsyncs": {str(k): v for k, v in sorted(disp_vsyncs.items())},
        "expected_display_interval_ms": {
            "mean": round((vf[-1]["expected_display"] - vf[0]["expected_display"]) / (len(vf) - 1), 4),
            "stdev": round(float(np.std(disp)), 3),
        },
    }


def source_tile_dirty(ffmpeg, path, width, height, tile=16):
    """Per-frame fraction of 16x16 tiles whose Y or co-sited U/V samples differ from the previous decoded frame."""
    ysz, csz = width * height, (width // 2) * (height // 2)
    th, tw = -(-height // tile), -(-width // tile)
    ypad = np.zeros((th * tile, tw * tile), dtype=bool)
    cpad = np.zeros((th * tile // 2, tw * tile // 2), dtype=bool)
    area = np.full((th, tw), float(tile * tile))
    if height % tile:
        area[-1] = (height % tile) * tile
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough",
           "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]  # fmt: skip
    out = []
    prev = None
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    try:
        while True:
            buf = proc.stdout.read(ysz + 2 * csz)
            if len(buf) < ysz + 2 * csz:
                break
            cur = np.frombuffer(buf, dtype=np.uint8)
            if prev is None:
                out.append(1.0)
            else:
                d = cur != prev
                ypad[:height, :width] = d[:ysz].reshape(height, width)
                tiles = ypad.reshape(th, tile, tw, tile).any(axis=(1, 3))
                for k in range(2):
                    cpad[: height // 2, : width // 2] = d[ysz + k * csz : ysz + (k + 1) * csz].reshape(height // 2, width // 2)
                    tiles |= cpad.reshape(th, tile // 2, tw, tile // 2).any(axis=(1, 3))
                out.append(float((area * tiles).sum() / (width * height)))
            prev = cur
    finally:
        proc.stdout.close()
        rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"ffmpeg decode of {path} failed with exit code {rc}")
    return np.array(out)


def dirty_fractions(sideinfo_path, width, height):
    fr = []
    with open(sideinfo_path) as f:
        for line in f:
            rec = json.loads(line)
            fr.append(sum(r[2] * r[3] for r in rec["dirty"]) / (width * height))
    return np.array(fr)


def dirty_distribution(captured):
    a = captured[1:]
    return {
        "min": round(float(a.min()), 6),
        "p01": round(float(np.percentile(a, 1)), 6),
        "p05": round(float(np.percentile(a, 5)), 6),
        "median": round(float(np.median(a)), 6),
        "frames_ge_0_99": int((a >= 0.99).sum()),
        "frames_ge_0_95": int((a >= 0.95).sum()),
        "frames_ge_0_90": int((a >= 0.90).sum()),
        "frames_lt_0_50": int((a < 0.5).sum()),
        "frames_considered": len(a),
    }


def dirty_vs_source(captured, source_dirty, source_index):
    """Compare captured per-frame dirty fractions with the source's own changed-tile fractions (frames 1..n-1)."""
    js = np.asarray(source_index[1:])
    ok = np.asarray(source_index[:-1]) + 1 == js
    cap = captured[1:][ok]
    src = source_dirty[js[ok]]
    d = cap - src
    return {
        "frames_compared": int(ok.sum()),
        "source_mean": round(float(src.mean()), 6),
        "captured_mean": round(float(cap.mean()), 6),
        "mean_abs_diff": round(float(np.abs(d).mean()), 6),
        "max_abs_diff": round(float(np.abs(d).max()), 6),
        "correlation": round(float(np.corrcoef(cap, src)[0, 1]), 6),
    }
