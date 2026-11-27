#!/usr/bin/env python3
"""Analyze a recording of the stimulus.

analyze.py <recording> --stimulus <stimulus run dir> --fps F [--warmup 3] [--start-ns N] [--stop-ns N] [--json out]

<recording> is a Cap .cap project dir, a display dir with init.mp4 + fragments, or a media file (mp4/mov/mkv).
Prints a JSON object with frame accounting, pacing, timing truth, bitrate and encoder facts.
Pure stdlib Python + ffmpeg/ffprobe on PATH.
"""
import argparse, csv, glob, json, os, re, subprocess, sys, tempfile, statistics

PX_PER_CELL = 8
COLS, ROWS = 10, 4


def crc8(v):
    crc = 0
    for b in ((v >> 16) & 0x3F, (v >> 8) & 0xFF, v & 0xFF):
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def pct(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    k = (len(s) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def dist(xs):
    if not xs:
        return None
    return {"p50": round(pct(xs, 0.5), 3), "p95": round(pct(xs, 0.95), 3), "p99": round(pct(xs, 0.99), 3),
            "max": round(max(xs), 3), "n": len(xs)}


def resolve_media(path, tmpdir):
    """Return (media_path, kind, parts)."""
    if os.path.isfile(path):
        return path, "file", [path]
    disp = None
    for cand in sorted(glob.glob(os.path.join(path, "content", "segments", "segment-*", "display"))):
        disp = cand
        break
    if disp is None and os.path.isdir(path):
        if glob.glob(os.path.join(path, "init.mp4")) or glob.glob(os.path.join(path, "display.mp4")):
            disp = path
    if disp is None:
        for cand in glob.glob(os.path.join(path, "content", "**", "display.mp4"), recursive=True):
            return cand, "file", [cand]
        for cand in glob.glob(os.path.join(path, "content", "**", "output.mp4"), recursive=True):
            return cand, "file", [cand]
        raise SystemExit(f"no display media under {path}")
    segs = sorted(glob.glob(os.path.join(os.path.dirname(disp), "segment-*"))) if "segments" in disp else [disp]
    nseg = len(glob.glob(os.path.join(path, "content", "segments", "segment-*"))) if os.path.isdir(os.path.join(path, "content")) else 1
    if os.path.isfile(os.path.join(disp, "display.mp4")):
        return os.path.join(disp, "display.mp4"), "file", [os.path.join(disp, "display.mp4")]
    full = os.path.join(os.path.dirname(disp), "display.mp4")
    if os.path.isfile(full):
        return full, "file", [full]
    init = os.path.join(disp, "init.mp4")
    frags = [f for f in os.listdir(disp) if f != "init.mp4" and (f.endswith(".m4s") or f.endswith(".mp4"))]

    def key(f):
        m = re.findall(r"\d+", f)
        return int(m[-1]) if m else -1
    frags.sort(key=key)
    out = os.path.join(tmpdir, "joined.mp4")
    with open(out, "wb") as w:
        for f in [init] + [os.path.join(disp, f) for f in frags]:
            with open(f, "rb") as r:
                w.write(r.read())
    return out, f"fragmented({len(frags)} fragments, {nseg} segments)", [init] + frags


def ffprobe_json(args):
    r = subprocess.run(["ffprobe", "-v", "error", "-of", "json"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffprobe failed: {r.stderr[-500:]}")
    return json.loads(r.stdout)


def encoder_sniff(path):
    with open(path, "rb") as f:
        head = f.read(4 << 20)
    m = re.search(rb"x264 - core \d+[^\x00]{0,60}", head)
    if m:
        return "libx264 (" + m.group(0)[:40].decode("latin1") + ")"
    return None


def decode_codes(media, stim, width, height):
    code = stim["code"]
    sx = width / stim["px_w"]
    sy = height / stim["px_h"]
    cell_x = code["cell"] * sx
    cell_y = code["cell"] * sy
    x0 = code["x"] * sx - cell_x / 2
    y0 = code["y"] * sy - cell_y / 2
    cw = cell_x * (COLS + 1)
    ch = cell_y * (ROWS + 1)
    ow, oh = PX_PER_CELL * (COLS + 1), PX_PER_CELL * (ROWS + 1)
    vf = f"crop={cw:.2f}:{ch:.2f}:{x0:.2f}:{y0:.2f}:exact=1,showinfo,scale={ow}:{oh}:flags=area,format=gray"
    cmd = ["ffmpeg", "-v", "info", "-nostdin", "-i", media, "-map", "0:v:0", "-vf", vf,
           "-fps_mode", "passthrough", "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = p.communicate()
    if p.returncode != 0:
        raise SystemExit(f"ffmpeg decode failed: {err[-800:].decode(errors='replace')}")
    pts = [float(m.group(1)) for m in re.finditer(rb"\] n:\s*\d+ pts:\s*-?\d+\s+pts_time:(-?[\d.e+-]+)", err)]
    fsz = ow * oh
    nframes = len(out) // fsz
    if len(pts) != nframes:
        raise SystemExit(f"pts/frame mismatch {len(pts)} vs {nframes}")
    half = PX_PER_CELL // 2
    q = PX_PER_CELL // 4
    results = []
    for i in range(nframes):
        buf = out[i * fsz:(i + 1) * fsz]

        def cell(c, r):
            cx = half + c * PX_PER_CELL + half
            cy = half + r * PX_PER_CELL + half
            s = 0
            for yy in range(cy - q, cy + q):
                row = yy * ow
                s += sum(buf[row + cx - q:row + cx + q])
            return s / (4 * q * q)
        pil = [cell(c, 0) for c in range(COLS)]
        whites = pil[0::2]
        blacks = pil[1::2]
        contrast = min(whites) - max(blacks)
        if contrast < 40:
            results.append((pts[i], None, "pilot"))
            continue
        thr = (statistics.mean(whites) + statistics.mean(blacks)) / 2
        margin = (statistics.mean(whites) - statistics.mean(blacks)) * 0.25
        bits = 0
        ambiguous = False
        for k in range(30):
            v = cell(k % COLS, 1 + k // COLS)
            if abs(v - thr) < margin:
                ambiguous = True
            bits = (bits << 1) | (1 if v > thr else 0)
        idx = bits >> 8
        if crc8(idx) != (bits & 0xFF) or ambiguous:
            results.append((pts[i], None, "crc" if not ambiguous else "ambiguous"))
            continue
        results.append((pts[i], idx, None))
    return results, {"crop": [round(x0, 1), round(y0, 1), round(cw, 1), round(ch, 1)]}


TRUTH = {}


def load_present(stim_dir, still=False):
    """idx -> present time (ns). Uses MTLDrawable.presentedTime. Where Metal reports 0 for every present
    (the still scene, which presents only on a version change, and every scene on the Mac mini display)
    it falls back to the display link's targetPresentationTimestamp; a skipped vsync still shows up there
    as a longer target interval. TRUTH[stim_dir] records which clock was used."""
    rows, target = {}, {}
    with open(os.path.join(stim_dir, "present.csv")) as f:
        for r in csv.DictReader(f):
            i = int(r["idx"])
            p = int(r["present_ns"])
            if p > 0:
                rows[i] = p
            t = int(r["target_ns"])
            if t > 0:
                target[i] = t
    if still or not rows:
        TRUTH[stim_dir] = "target_ns"
        return target
    TRUTH[stim_dir] = "present_ns"
    return rows


def linfit(xs, ys):
    n = len(xs)
    if n < 3:
        return None, None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None, None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return b, my - b * mx


def analyze(recording, stim_dir, fps, warmup, start_ns=None, stop_ns=None):
    stim = json.load(open(os.path.join(stim_dir, "stimulus.json")))
    still = stim["scene"] == "still"
    present = load_present(stim_dir, still)
    hz = stim.get("summary", {}).get("achieved_fps") or stim["hz_requested"]
    nominal_hz = stim["hz_requested"]
    tmp = tempfile.mkdtemp(prefix="anz-")
    try:
        media, kind, parts = resolve_media(recording, tmp)
        total_bytes = sum(os.path.getsize(p if os.path.isabs(p) else os.path.join(os.path.dirname(parts[0]), p)) for p in parts) if kind != "file" else os.path.getsize(media)
        info = ffprobe_json(["-show_streams", "-show_format", "-select_streams", "v:0", media])
        st = info["streams"][0]
        all_streams = ffprobe_json(["-show_entries", "stream=codec_type,codec_name", media])["streams"]
        fmt = info["format"]
        pk = ffprobe_json(["-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time,flags,size", media])["packets"]
        frames, geo = decode_codes(media, stim, st["width"], st["height"])
        sniff = encoder_sniff(media)
    finally:
        for f in glob.glob(os.path.join(tmp, "*")):
            os.remove(f)
        os.rmdir(tmp)

    pts_all = [f[0] for f in frames]
    t0 = pts_all[0] if pts_all else 0.0
    win = [f for f in frames if f[0] >= t0 + warmup]
    head = [f for f in frames if f[0] < t0 + warmup]
    readable = [f for f in win if f[1] is not None]
    unreadable = {}
    for f in win:
        if f[1] is None:
            unreadable[f[2]] = unreadable.get(f[2], 0) + 1

    def accounting(seg):
        rd = [f for f in seg if f[1] is not None]
        if not rd:
            return None
        seen = set()
        dups = 0
        backwards = 0
        prev = None
        steps = []
        for f in rd:
            i = f[1]
            if i in seen:
                dups += 1
            else:
                if prev is not None:
                    if i < prev:
                        backwards += 1
                    else:
                        steps.append(i - prev)
                seen.add(i)
                prev = i
        lo, hi = min(seen), max(seen)
        shown = sum(1 for i in range(lo, hi + 1) if i in present)
        uniq = len(seen)
        span_s = (present[hi] - present[lo]) / 1e9 if lo in present and hi in present and hi > lo else 0
        res = {"first_idx": lo, "last_idx": hi, "stimulus_shown": shown, "unique": uniq,
               "duplicates": dups, "backwards": backwards, "decoded_frames": len(seg),
               "stimulus_span_s": round(span_s, 4)}
        if still:
            res["missed_versions"] = shown - uniq
            return res
        ideal = max(1.0, nominal_hz / fps)
        # Expected = target-rate slots (width 1/fps, on the stimulus present clock) that had at least one
        # presented stimulus frame. A stimulus stall leaves a slot empty and is not charged to the recorder.
        slot_ns = 1e9 / min(fps, nominal_hz)
        p0 = present.get(lo)
        slots = {int((present[i] - p0) / slot_ns + 0.25) for i in range(lo, hi + 1) if i in present} if p0 else set()
        hit = {int((present[i] - p0) / slot_ns + 0.25) for i in seen if i in present} if p0 else set()
        expected = len(slots) if slots else shown / ideal
        res["expected_at_target"] = expected
        res["missed"] = max(0, expected - uniq)
        res["missed_slots"] = len(slots - hit)
        res["extra_in_slot"] = uniq - len(hit)
        res["missed_stimulus"] = shown - uniq
        big = [s for s in steps if s > ideal * 1.5]
        res["gaps"] = len(big)
        res["gap_frames_lost"] = round(sum(s / ideal - 1 for s in big), 1)
        hist = {}
        for s in steps:
            hist[s] = hist.get(s, 0) + 1
        res["step_hist"] = {str(k): v for k, v in sorted(hist.items())[:12]}
        res["longest_gap_ms"] = round(max(s for s in steps) * 1000 / nominal_hz, 2) if steps else None
        return res

    acc = accounting(win) or {}
    acc_head = accounting(head)
    pts_win = [f[0] for f in win]
    deltas = [(b - a) * 1000 for a, b in zip(pts_win, pts_win[1:])]
    target_ms = 1000.0 / fps
    dev = [abs(d - target_ms) for d in deltas]
    dur_pts = (pts_win[-1] - pts_win[0]) if len(pts_win) > 1 else 0
    eff_fps_pts = (len(pts_win) - 1) / dur_pts if dur_pts > 0 else None
    uniq_n = acc.get("unique", 0)
    eff_fps_unique = (uniq_n - 1) / acc["stimulus_span_s"] if acc.get("stimulus_span_s") else None

    firsts = {}
    for f in readable:
        if f[1] not in firsts:
            firsts[f[1]] = f[0]
    pairs = [(present[i] / 1e9, firsts[i]) for i in sorted(firsts) if i in present]
    timing = None
    if len(pairs) > 3:
        xs = [p[0] - pairs[0][0] for p in pairs]
        offs = [(p[1] - p[0]) * 1000 for p in pairs]
        base = min(offs)
        rel = [o - base for o in offs]
        slope, _ = linfit(xs, offs)
        timing = {"pts_minus_present_ms_rel": dist(rel),
                  "drift_ms_per_min": round(slope * 60, 3) if slope is not None else None}

    pk_win = [p for p in pk if p.get("pts_time") not in (None, "N/A") and float(p["pts_time"]) >= t0 + warmup]
    win_bytes = sum(int(p["size"]) for p in pk_win)
    keys = [float(p["pts_time"]) for p in pk if "K" in p.get("flags", "") and p.get("pts_time") not in (None, "N/A")]
    gop_s = statistics.median([b - a for a, b in zip(keys, keys[1:])]) if len(keys) > 1 else None
    reorder = False
    mx = -1e18
    for p in pk:
        if p.get("pts_time") in (None, "N/A"):
            continue
        v = float(p["pts_time"])
        if v < mx:
            reorder = True
            break
        mx = max(mx, v)
    duration = float(fmt.get("duration") or 0) or (pts_all[-1] - t0 if pts_all else 0)

    start = None
    if start_ns is not None and acc_head:
        fi = (acc_head or acc).get("first_idx")
        if fi in present:
            start = {"first_frame_present_after_start_ms": round((present[fi] - start_ns) / 1e6, 1)}
    return {
        "recording": recording, "media_kind": kind, "warmup_s": warmup, "target_fps": fps,
        "stimulus": {"scene": stim["scene"], "hz_requested": nominal_hz, "achieved_fps": round(hz, 3),
                     "stim_summary": stim.get("summary")},
        "truth_clock": TRUTH.get(stim_dir),
        "window": acc,
        "warmup_window": acc_head,
        "unreadable_in_window": unreadable,
        "effective_fps_pts": round(eff_fps_pts, 3) if eff_fps_pts else None,
        "effective_fps_unique": round(eff_fps_unique, 3) if eff_fps_unique else None,
        "pts_delta_ms": dist(deltas),
        "pts_dev_from_target_ms": dist(dev),
        "timing_truth": timing,
        "start": start,
        "bitrate_kbps_file": round(total_bytes * 8 / duration / 1000, 1) if duration else None,
        "bitrate_kbps_window": round(win_bytes * 8 / dur_pts / 1000, 1) if dur_pts else None,
        "file_bytes": total_bytes, "duration_s": round(duration, 3),
        "encoder": {"codec": st.get("codec_name"), "profile": st.get("profile"), "level": st.get("level"),
                    "pix_fmt": st.get("pix_fmt"), "width": st.get("width"), "height": st.get("height"),
                    "color_range": st.get("color_range"), "color_space": st.get("color_space"),
                    "color_transfer": st.get("color_transfer"), "color_primaries": st.get("color_primaries"),
                    "r_frame_rate": st.get("r_frame_rate"), "avg_frame_rate": st.get("avg_frame_rate"),
                    "time_base": st.get("time_base"), "has_b_frames": st.get("has_b_frames"),
                    "reordered_packets": reorder, "gop_s": round(gop_s, 3) if gop_s else None,
                    "keyframes": len(keys), "packets": len(pk), "encoder_tag": (st.get("tags") or {}).get("encoder") or (fmt.get("tags") or {}).get("encoder"),
                    "handler": (st.get("tags") or {}).get("handler_name"), "sniff": sniff,
                    "container": fmt.get("format_name"),
                    "audio_streams": [s.get("codec_name") for s in all_streams if s.get("codec_type") == "audio"]},
        "geometry": geo,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recording")
    ap.add_argument("--stimulus", required=True)
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--warmup", type=float, default=3.0)
    ap.add_argument("--start-ns", type=int)
    ap.add_argument("--json")
    a = ap.parse_args()
    res = analyze(a.recording, a.stimulus, a.fps, a.warmup, a.start_ns)
    s = json.dumps(res, indent=1)
    if a.json:
        open(a.json, "w").write(s)
    print(s)


if __name__ == "__main__":
    main()
