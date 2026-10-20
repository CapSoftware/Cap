#!/usr/bin/env python3
"""Compute per-frame side info for a lossless capture.

Output: one JSON object per frame
    {"frame": i, "t_ms": float, "dirty": [[x,y,w,h],...], "cursor": [x,y] | null,
     "scroll": [{"rect": [x,y,w,h], "dx": int, "dy": int, "id": str, "valid": bool | null,
                 "align": "latency" | "realigned", "match": float | null}, ...]}

dirty   exact pixel diff vs. the previous decoded frame (frame 0: whole frame),
        marked on a 16x16 tile grid, merged into horizontal runs per tile row and
        then vertically when consecutive rows have a run with the same x-extent.
        Rects are 16-aligned and clipped to the frame.
cursor  pointer position (hotspot, screen px) of the latest 240 Hz sample taken
        at or before T_frame + C. x11grab paints the cursor after grabbing the
        image, just before the wallclock pts is taken, so C is fitted per clip in
        [-12, +12] ms by requiring the hotspot tile to be dirty at both the old and
        the new position on every frame where the pointer moved.
scroll  per tracked scroll container whose offset changed since the previous
        frame: content moved by (dx, dy) screen px inside rect (dy < 0 when the
        content moves up). Offsets are page-reported scrollLeft/scrollTop
        (scroll events + every rAF) x device scale factor. valid is null when the
        jump is larger than the container (no overlapping pixels to compare).

Scroll alignment: pass 1 fits one global report-to-screen latency L by
validating every candidate L against the pixels. Pass 2 walks the frames in
order and, per container, takes the offset reported at T_frame - L when the
pixels confirm it ("latency"); otherwise it may pick another reported offset
within +-1 frame of that instant if the pixels confirm that one ("realigned"),
or keep the previous offset if the container did not change on screen yet.
Entries that no candidate explains keep the latency-based value, valid=false.

Usable as a module (compute()) or from the command line.
"""

import argparse
import bisect
import json
import subprocess
import sys

import numpy as np

TILE = 16
MATCH_THRESHOLD = 0.9
RESIDUAL_MAX = 0.25
HELD_THRESHOLD = 0.998
CURSOR_FIT_MS = (-12, 12)


def read_jsonl(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def iter_frames(ffmpeg, video, width, height):
    size = width * height * 4
    proc = subprocess.Popen(
        [ffmpeg, "-v", "error", "-nostdin", "-i", video, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "bgr0", "-"],
        stdout=subprocess.PIPE,
        bufsize=0,
    )
    bufs = [bytearray(size), bytearray(size)]
    k = 0
    complete = False
    try:
        while True:
            buf = bufs[k]
            view = memoryview(buf)
            got = 0
            while got < size:
                n = proc.stdout.readinto(view[got:])
                if not n:
                    break
                got += n
            if got < size:
                complete = True
                break
            yield np.frombuffer(buf, dtype=np.uint32).reshape(height, width)
            k ^= 1
    finally:
        proc.stdout.close()
        rc = proc.wait()
        if complete and rc != 0:
            raise RuntimeError(f"ffmpeg decode of {video} failed with exit code {rc}")


def tile_mask(diff, th, tw):
    h, w = diff.shape
    if h != th * TILE or w != tw * TILE:
        padded = np.zeros((th * TILE, tw * TILE), dtype=bool)
        padded[:h, :w] = diff
        diff = padded
    return diff.reshape(th, TILE, tw, TILE).any(axis=(1, 3))


def rects_from_tiles(mask, width, height):
    th, tw = mask.shape
    active = {}
    out = []

    def emit(key, y0, y1):
        x0, x1 = key
        x = x0 * TILE
        y = y0 * TILE
        out.append([x, y, min(x1 * TILE, width) - x, min(y1 * TILE, height) - y])

    for r in range(th + 1):
        runs = set()
        if r < th and mask[r].any():
            d = np.diff(np.concatenate(([0], mask[r].astype(np.int8), [0])))
            runs = set(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))
        for key in [k for k in active if k not in runs]:
            emit(key, active.pop(key), r)
        for key in runs:
            if key not in active:
                active[key] = r
    out.sort(key=lambda q: (q[1], q[0]))
    return out


def clip_rect(rect, width, height):
    x, y, w, h = rect
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(width, x + w), min(height, y + h)
    if x1 <= x0 or y1 <= y0:
        return None
    return [x0, y0, x1 - x0, y1 - y0]


class ScrollTrack:
    def __init__(self, records, dsf):
        self.dsf = dsf
        self.ts = [r["_t"] for r in records]
        self.recs = records

    def index_at(self, t):
        return bisect.bisect_right(self.ts, t) - 1

    def state_at(self, t):
        i = self.index_at(t)
        return self.recs[i] if i >= 0 else None

    def offset(self, rec):
        return round(rec["sx"] * self.dsf), round(rec["sy"] * self.dsf)

    def rect(self, rec, width, height):
        x, y, w, h = rec["rect"]
        d = self.dsf
        return clip_rect([round(x * d), round(y * d), round(w * d), round(h * d)], width, height)


def shift_match(prev, cur, rect, dx, dy, mask_boxes):
    x, y, w, h = rect
    cx0, cx1 = max(x, x + dx), min(x + w, x + w + dx)
    cy0, cy1 = max(y, y + dy), min(y + h, y + h + dy)
    if cx1 - cx0 < 8 or cy1 - cy0 < 4:
        return None
    a = cur[cy0:cy1, cx0:cx1]
    b = prev[cy0 - dy : cy1 - dy, cx0 - dx : cx1 - dx]
    z = prev[cy0:cy1, cx0:cx1]
    keep = np.ones(a.shape, dtype=bool)
    for bx0, by0, bx1, by1 in mask_boxes:
        ix0, iy0 = max(bx0, cx0) - cx0, max(by0, cy0) - cy0
        ix1, iy1 = min(bx1, cx1) - cx0, min(by1, cy1) - cy0
        if ix1 > ix0 and iy1 > iy0:
            keep[iy0:iy1, ix0:ix1] = False
    n = int(keep.sum())
    if n == 0:
        return None
    m_shift = float(np.count_nonzero((a == b) & keep)) / n
    m_zero = float(np.count_nonzero((a == z) & keep)) / n
    return [round(m_shift, 6), round(m_zero, 6), (cx1 - cx0) * (cy1 - cy0)]


def is_valid(res):
    """Shifted previous frame matches the overlap and explains most of the change.

    res = [match_with_shift, match_without_shift, overlap_px]. On mostly-uniform
    content a shift that is off by 1px still matches ~95% of pixels, so besides
    the absolute threshold the shift must remove >= 75% of the mismatches of the
    unshifted comparison.
    """
    if res is None:
        return False
    m_shift, m_zero = res[0], res[1]
    if m_shift < MATCH_THRESHOLD:
        return False
    return (1.0 - m_shift) <= RESIDUAL_MAX * (1.0 - m_zero) or m_shift >= 0.9995


def compute(
    video,
    frame_times_ms,
    width,
    height,
    dsf,
    pointer_samples,
    scroll_records,
    out_path,
    ffmpeg="ffmpeg",
    grab_latency_ms=0.0,
    latency_range_ms=(-70, 70),
    latency_step_ms=2,
    cursor_box=None,
):
    n_frames = len(frame_times_ms)
    th = (height + TILE - 1) // TILE
    tw = (width + TILE - 1) // TILE
    box = cursor_box or (34 if dsf <= 1 else 60)
    frame_dur = (frame_times_ms[-1] - frame_times_ms[0]) / max(1, n_frames - 1)

    ptr = sorted(((p["t"], p["x"], p["y"]) for p in pointer_samples), key=lambda q: q[0])
    ptr_t = [p[0] for p in ptr]

    def cursor_at(t):
        i = bisect.bisect_right(ptr_t, t) - 1
        if i < 0:
            return None
        _, x, y = ptr[i]
        if 0 <= x < width and 0 <= y < height:
            return [x, y]
        return None

    cursors = [cursor_at(t) for t in frame_times_ms]

    by_id = {}
    for r in scroll_records:
        r = dict(r)
        r["_t"] = r.get("tp", r["t"])
        by_id.setdefault(r["id"], []).append(r)
    tracks = {}
    for sid, recs in sorted(by_id.items()):
        recs.sort(key=lambda q: q["_t"])
        tracks[sid] = ScrollTrack(recs, dsf)

    def boxes_for(i, dx, dy):
        out = []
        for c, off in ((cursors[i], (0, 0)), (cursors[i - 1], (0, 0)), (cursors[i - 1], (dx, dy))):
            if c is not None:
                cx, cy = c[0] + off[0], c[1] + off[1]
                out.append((cx - box, cy - box, cx + box, cy + box))
        return out

    latencies = list(range(latency_range_ms[0], latency_range_ms[1] + 1, latency_step_ms))

    def deltas_for(lat):
        per_frame = [[] for _ in range(n_frames)]
        for sid, tr in tracks.items():
            prev_rec = tr.state_at(frame_times_ms[0] - lat)
            for i in range(1, n_frames):
                rec = tr.state_at(frame_times_ms[i] - lat)
                if rec is not None and prev_rec is not None:
                    ox0, oy0 = tr.offset(prev_rec)
                    ox1, oy1 = tr.offset(rec)
                    if (ox0, oy0) != (ox1, oy1):
                        rect = tr.rect(rec, width, height)
                        if rect is not None:
                            per_frame[i].append((sid, tuple(rect), -(ox1 - ox0), -(oy1 - oy0)))
                prev_rec = rec
        return per_frame

    by_latency = {lat: deltas_for(lat) for lat in latencies}
    candidates = [set() for _ in range(n_frames)]
    for per_frame in by_latency.values():
        for i, items in enumerate(per_frame):
            candidates[i].update(items)

    results = {}
    tiles = np.zeros((n_frames, th, tw), dtype=bool)
    dirty = []
    identical = 0
    prev = None
    decoded = 0
    for i, cur in enumerate(iter_frames(ffmpeg, video, width, height)):
        decoded += 1
        if i >= n_frames:
            continue
        if prev is None:
            tiles[i] = True
            dirty.append([[0, 0, width, height]])
        else:
            mask = tile_mask(cur != prev, th, tw)
            tiles[i] = mask
            if not mask.any():
                identical += 1
                dirty.append([])
            else:
                dirty.append(rects_from_tiles(mask, width, height))
            for cand in candidates[i]:
                sid, rect, dx, dy = cand
                results[(i, cand)] = shift_match(prev, cur, rect, dx, dy, boxes_for(i, dx, dy))
        prev = cur
    if decoded != n_frames:
        raise RuntimeError(f"decoded {decoded} frames but capture log lists {n_frames}")

    def cursor_consistency(offset_ms):
        cur = [cursor_at(t + offset_ms) for t in frame_times_ms]
        moved = consistent = 0
        for i in range(1, n_frames):
            a, b = cur[i - 1], cur[i]
            if a is None or b is None or a == b:
                continue
            moved += 1
            consistent += bool(tiles[i, a[1] // TILE, a[0] // TILE] and tiles[i, b[1] // TILE, b[0] // TILE])
        return consistent, moved, cur

    cursor_fit = {}
    for off in range(CURSOR_FIT_MS[0], CURSOR_FIT_MS[1] + 1):
        c, m, _ = cursor_consistency(off)
        cursor_fit[off] = (c, m)
    cursor_frac = {off: round(c / m, 6) if m else 0.0 for off, (c, m) in cursor_fit.items()}
    best_frac = max(cursor_frac.values())
    cursor_plateau = [off for off, f in cursor_frac.items() if f == best_frac]
    cursor_offset = cursor_plateau[len(cursor_plateau) // 2] if best_frac else 0
    _, _, cursors = cursor_consistency(cursor_offset)

    def score(lat):
        good = bad = 0
        for i, items in enumerate(by_latency[lat]):
            for cand in items:
                if is_valid(results.get((i, cand))):
                    good += 1
                else:
                    bad += 1
        return good - bad, good, bad

    scores = {lat: score(lat) for lat in latencies}
    has_scroll = any(s[1] + s[2] for s in scores.values())
    chosen_lat = 0
    if has_scroll:
        best = max(s[0] for s in scores.values())
        plateau = [lat for lat in latencies if scores[lat][0] == best]
        chosen_lat = plateau[len(plateau) // 2]

    entries = [[] for _ in range(n_frames)]
    align_counts = {"latency": 0, "realigned": 0, "held": 0, "invalid": 0, "unverifiable": 0}
    if has_scroll:
        window = frame_dur
        plans = {}
        for sid, tr in tracks.items():
            plan = []
            for t in frame_times_ms:
                tt = t - chosen_lat
                plan.append((tr.index_at(tt), bisect.bisect_left(tr.ts, tt - window), bisect.bisect_right(tr.ts, tt + window)))
            plans[sid] = plan
        chosen = {sid: plans[sid][0][0] for sid in tracks}
        prev = None
        for i, cur in enumerate(iter_frames(ffmpeg, video, width, height)):
            if i >= n_frames:
                continue
            if prev is None:
                prev = cur
                continue
            for sid, tr in tracks.items():
                c = chosen[sid]
                g, lo, hi = plans[sid][i]
                if c < 0:
                    chosen[sid] = g
                    continue
                off_c = tr.offset(tr.recs[c])
                pool = set(range(max(lo, c), hi))
                if g >= c:
                    pool.add(g)
                cands = {}
                for idx in pool:
                    off = tr.offset(tr.recs[idx])
                    if off != off_c and (off not in cands or abs(idx - g) < abs(cands[off] - g)):
                        cands[off] = idx
                if not cands:
                    if g > c:
                        chosen[sid] = g
                    continue
                g_off = tr.offset(tr.recs[g]) if g >= c else off_c
                rect = tr.rect(tr.recs[max(g, c)], width, height)
                if rect is None:
                    chosen[sid] = max(g, c)
                    continue
                res = {}
                for off, idx in cands.items():
                    dx, dy = -(off[0] - off_c[0]), -(off[1] - off_c[1])
                    res[off] = (idx, dx, dy, shift_match(prev, cur, rect, dx, dy, boxes_for(i, dx, dy)))
                ref = res.get(g_off) or next(iter(res.values()))
                m_zero = ref[3][1] if ref[3] is not None else None
                if g_off != off_c and is_valid(res[g_off][3]):
                    pick, status = res[g_off], "latency"
                elif m_zero is not None and m_zero >= HELD_THRESHOLD:
                    pick, status = None, ("held" if g_off != off_c else None)
                else:
                    ok = [r for r in res.values() if is_valid(r[3])]
                    if ok:
                        pick, status = max(ok, key=lambda r: r[3][0]), "realigned"
                    elif g_off != off_c and res[g_off][3] is None:
                        pick, status = res[g_off], "unverifiable"
                    elif g_off != off_c:
                        pick, status = res[g_off], "invalid"
                    else:
                        pick, status = None, None
                if status:
                    align_counts[status] += 1
                if pick is None:
                    continue
                idx, dx, dy, r = pick
                chosen[sid] = idx
                entries[i].append(
                    {
                        "rect": list(rect),
                        "dx": dx,
                        "dy": dy,
                        "id": sid,
                        "valid": None if status == "unverifiable" else status != "invalid",
                        "align": "realigned" if status == "realigned" else "latency",
                        "match": r[0] if r else None,
                    }
                )
            prev = cur

    tile_area = np.full((th, tw), TILE * TILE, dtype=np.int64)
    if height % TILE:
        tile_area[-1, :] = (height % TILE) * TILE
    if width % TILE:
        tile_area[:, -1] = tile_area[:, -1] // TILE * (width % TILE)
    dirty_frac = [(tile_area * tiles[i]).sum() / (width * height) for i in range(n_frames)]

    consistent, moved = cursor_fit[cursor_offset]
    consistent_at_zero, moved_at_zero = cursor_fit.get(0, (0, 0))

    scroll_frames = valid_frames = unverifiable_frames = 0
    n_entries = n_valid = n_unverifiable = 0
    with open(out_path, "w") as f:
        for i in range(n_frames):
            scroll = entries[i]
            if scroll:
                scroll_frames += 1
                verdicts = [e["valid"] for e in scroll if e["valid"] is not None]
                if not verdicts:
                    unverifiable_frames += 1
                elif all(verdicts):
                    valid_frames += 1
                n_entries += len(scroll)
                n_valid += sum(e["valid"] is True for e in scroll)
                n_unverifiable += sum(e["valid"] is None for e in scroll)
            rec = {
                "frame": i,
                "t_ms": round(frame_times_ms[i] - frame_times_ms[0], 3),
                "dirty": dirty[i],
                "cursor": cursors[i],
                "scroll": scroll,
            }
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")

    lat_frames = by_latency[chosen_lat] if has_scroll else [[] for _ in range(n_frames)]
    lat_verifiable = [
        (i, [c for c in items if results.get((i, c)) is not None]) for i, items in enumerate(lat_frames) if items
    ]
    lat_scroll_frames = sum(1 for _, items in lat_verifiable if items)
    lat_valid_frames = sum(1 for i, items in lat_verifiable if items and all(is_valid(results[(i, c)]) for c in items))
    later = dirty_frac[1:] if n_frames > 1 else dirty_frac
    return {
        "frames": n_frames,
        "avg_dirty_fraction": round(float(np.mean(later)), 6),
        "median_dirty_fraction": round(float(np.median(later)), 6),
        "max_dirty_fraction": round(float(np.max(later)), 6),
        "identical_frames": identical,
        "cursor": {
            "frames_with_cursor": sum(c is not None for c in cursors),
            "moved_frames": moved,
            "moved_frames_with_dirty_hotspot_tile_at_old_and_new_pos": consistent,
            "fraction": round(consistent / moved, 4) if moved else None,
            "sample_offset_ms": cursor_offset,
            "fraction_at_zero_offset": round(consistent_at_zero / moved_at_zero, 4) if moved_at_zero else None,
            "grab_latency_ms": grab_latency_ms,
            "method": "latest 240 Hz query_pointer sample at or before frame wallclock + sample_offset_ms; offset "
            f"fitted in [{CURSOR_FIT_MS[0]}, {CURSOR_FIT_MS[1]}] ms (1 ms steps) to maximise frames whose hotspot "
            "tile is dirty at both the previous and the new position",
        },
        "scroll": {
            "frames_with_scroll": scroll_frames,
            "unverifiable_frames": unverifiable_frames,
            "validated_frames": valid_frames,
            "fraction": round(valid_frames / (scroll_frames - unverifiable_frames), 4)
            if scroll_frames > unverifiable_frames
            else None,
            "entries": n_entries,
            "valid_entries": n_valid,
            "unverifiable_entries": n_unverifiable,
            "align_counts": align_counts,
            "latency_ms": chosen_lat if has_scroll else None,
            "latency_frames": round(chosen_lat / frame_dur, 2) if has_scroll else None,
            "latency_only": {
                "frames_with_scroll": lat_scroll_frames,
                "validated_frames": lat_valid_frames,
                "fraction": round(lat_valid_frames / lat_scroll_frames, 4) if lat_scroll_frames else None,
                "score_at_chosen_latency": list(scores[chosen_lat]) if has_scroll else None,
                "score_at_zero_latency": list(scores[0]) if has_scroll and 0 in scores else None,
            },
            "match_threshold": MATCH_THRESHOLD,
            "residual_max": RESIDUAL_MAX,
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--capture", required=True, help="<name>.capture.json written by generate.py")
    ap.add_argument("--events", required=True, help="<name>.events.jsonl (scroll records)")
    ap.add_argument("--pointer", required=True, help="<name>.pointer.jsonl (240 Hz samples)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--stats", help="write summary stats JSON here")
    args = ap.parse_args()
    cap = json.load(open(args.capture))
    scroll = [e for e in read_jsonl(args.events) if e.get("k") == "scroll"]
    stats = compute(
        args.video,
        cap["frame_wallclock_ms"],
        cap["width"],
        cap["height"],
        cap["dsf"],
        read_jsonl(args.pointer),
        scroll,
        args.out,
        ffmpeg=args.ffmpeg,
        grab_latency_ms=cap.get("grab_latency_ms", 0.0),
    )
    text = json.dumps(stats, indent=2)
    if args.stats:
        with open(args.stats, "w") as f:
            f.write(text + "\n")
    print(text)


if __name__ == "__main__":
    sys.exit(main())
