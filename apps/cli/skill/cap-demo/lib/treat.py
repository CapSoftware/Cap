#!/usr/bin/env python3
"""cap-demo TREAT + EXPORT (adapted from treat.py; all shot math, brand-gradient
and editorial logic preserved verbatim, only I/O, binary/asset/music resolution
and CLI args changed).

Aligns beats to video, trims, aims 3D shots at landmarks, paints a brand
background, synthesizes the cursor track from the bundled cursor assets, copies
music, writes project-config.json, and exports via the Cap CLI.

Usage: python3 treat.py <outDir> <slug> [--music ID] [--quality 4k|hd] [--bg-gradient FROM_HEX,TO_HEX]
"""
import argparse
import colorsys
import json
import math
import os
import shutil
import subprocess
import sys

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(SKILL_DIR, "assets")


def resolve_cap():
    """Cap binary: env CAP_BIN, else `cap` on PATH, else a clear error."""
    if os.environ.get("CAP_BIN"):
        return os.environ["CAP_BIN"]
    p = shutil.which("cap")
    if p:
        return p
    raise SystemExit(
        "cap CLI not found on PATH. Install Cap Desktop (https://cap.so) or set CAP_BIN."
    )


def resolve_music(music_id):
    bundled = os.path.join(ASSETS, "music", f"{music_id}.mp3")
    if os.path.exists(bundled):
        return bundled
    raise SystemExit(
        f"music not found: {music_id} (looked in {os.path.join(ASSETS, 'music')})"
    )


def parse_bg_override(spec):
    parts = [p.strip() for p in spec.split(",")]
    if len(parts) != 2:
        raise SystemExit("--bg-gradient must be FROM_HEX,TO_HEX (e.g. 261A40,0C0914)")

    def hexrgb(h):
        h = h.lstrip("#")
        if len(h) != 6:
            raise SystemExit(f"invalid hex color: {h}")
        return [int(h[i:i + 2], 16) for i in (0, 2, 4)]

    return {"type": "gradient", "from": hexrgb(parts[0]), "to": hexrgb(parts[1]), "angle": 135}


ap = argparse.ArgumentParser()
ap.add_argument("outDir")
ap.add_argument("slug")
ap.add_argument("--music", default="lofi-cinematic-pulsebox")
ap.add_argument("--quality", choices=["4k", "hd"], default=None)
ap.add_argument("--bg-gradient", dest="bg_gradient", default=None)
args = ap.parse_args()

outDir = args.outDir
slug = args.slug
music = args.music
CAP = resolve_cap()

proj = os.path.join(outDir, f"{slug}.cap")

with open(os.path.join(outDir, f"{slug}.timeline.json")) as f:
    tl = json.load(f)
events = {e["name"]: e for e in tl["events"]}
story = tl["story"]
scout = tl["scout"]

video = f"{proj}/content/segments/segment-0/display.mp4"
probe = subprocess.run(
    ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", video],
    capture_output=True, text=True).stdout.strip()
vdur = float(probe)
dims = subprocess.run(
    ["ffprobe", "-v", "quiet", "-show_entries", "stream=width,height", "-of", "csv=p=0", video],
    capture_output=True, text=True).stdout.strip()
W, H = [int(x) for x in dims.split(",")[:2]]
aspect = W / H
hx, hy = (1.0, 1.0 / aspect) if aspect >= 1 else (aspect, 1.0)

# Tail-anchored alignment: micro-drift keeps frames flowing to the end.
offset = events["end"]["t"] - vdur
def v(name):
    return max(0.0, events[name]["t"] - offset)

# --- camera math ---------------------------------------------------------------
def rot(axis, deg):
    t = math.radians(deg); c, s = math.cos(t), math.sin(t)
    if axis == "x": return [[1, 0, 0], [0, c, -s], [0, s, c]]
    if axis == "y": return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]]

def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

def aim_pan(p, frac):
    R = mul(mul(rot("y", p["tiltY"]), mul(rot("x", p["tiltX"]), rot("z", p["roll"]))),
            mul(rot("y", p["rotateY"]), rot("x", p["rotateX"])))
    u = 0.5 + (frac[0] - 0.5) * 0.9
    vv = 0.5 + (frac[1] - 0.5) * 0.9
    X, Y = (2 * u - 1) * hx, (1 - 2 * vv) * hy
    return (-(R[0][0] * X + R[0][1] * Y), -(R[1][0] * X + R[1][1] * Y))

def props(**kw):
    base = {"tiltX": 0.0, "tiltY": 0.0, "roll": 0.0, "rotateX": 0.0, "rotateY": 0.0,
            "fov": 45.0, "zoom": 2.0, "panX": 0.0, "panY": 0.0}
    base.update(kw); return base

def clamp_cut(a, b, ceiling, floor=0.0, min_dur=0.4):
    """Force a (start, end) cut forward within [floor, ceiling] by at least min_dur."""
    a = max(floor, min(a, ceiling - min_dur))
    b = max(a + min_dur, min(b, ceiling))
    return (a, b)

def kf(t, val, first):
    k = {"time": t, "value": val}
    k["outEasing" if first else "inEasing"] = [0.0, 0.0] if first else [1.0, 1.0]
    return k

def tracks_between(p0, p1, length):
    return {key: [kf(0.0, p0[key], True), kf(length, p1[key], False)]
            for key in p0 if abs(p0[key] - p1[key]) > 1e-6}

def blur(st, fo, sz):
    return {"mode": "radial", "strength": st, "falloff": fo, "focusX": 0.5, "focusY": 0.46,
            "focusSize": sz, "angle": 0.0, "dirPosition": 0.5, "bokeh": True}

def shot(a, b, p0, p1, bl):
    return {"start": a, "end": b, "enabled": True, "properties": p0, "blur": bl,
            "tracks": tracks_between(p0, p1, b - a), "transitionIn": 0.0, "transitionOut": 0.0}

def frac_of(name, default):
    e = events.get(name)
    return (e["x"], e["y"]) if e and "x" in e else default

# --- brand background ----------------------------------------------------------
def brand_gradient():
    accent = scout.get("accent")
    bg = scout.get("pageBg")
    def tune(rgb, lo, hi, sat_cap=0.75):
        r, g, b = [c / 255 for c in rgb]
        h, l, s = colorsys.rgb_to_hls(r, g, b)
        l = min(max(l, lo), hi)
        s = min(s, sat_cap)
        r, g, b = colorsys.hls_to_rgb(h, l, s)
        return [int(r * 255), int(g * 255), int(b * 255)]
    if accent and bg:
        return {"type": "gradient", "from": tune(accent, 0.18, 0.42), "to": tune(bg, 0.10, 0.30), "angle": 135}
    if accent:
        base = tune(accent, 0.18, 0.42)
        return {"type": "gradient", "from": base, "to": tune(accent, 0.08, 0.2), "angle": 135}
    if bg and (sum(bg) / 3) > 150:  # light brand -> soft light gradient
        return {"type": "gradient", "from": tune(bg, 0.86, 0.94, 0.25), "to": tune(bg, 0.72, 0.82, 0.35), "angle": 135}
    return {"type": "gradient", "from": [38, 40, 58], "to": [16, 17, 26], "angle": 135}

bg_source = parse_bg_override(args.bg_gradient) if args.bg_gradient else brand_gradient()

# --- editorial cut -------------------------------------------------------------
HERO = frac_of("hero_frac", (0.5, 0.4))

if story == "click":
    CTA = frac_of("cta_frac", (0.5, 0.6))
    PAGE2 = frac_of("page2_frac", (0.42, 0.45))
    click = v("click_cta")
    ready = v("page_ready")
    scroll = v("scroll_start")
    cutA = (0.25, min(click + 0.4, ready - 0.1))
    cutB = (ready + 0.5, vdur - 0.05)
else:
    CTA = HERO
    PAGE2 = (0.5, 0.45)
    s1 = v("scroll1_start")
    scroll = v("scroll_start")
    cutA = (0.25, s1 + 0.9)          # hero through the first scroll's start
    cutB = (s1 + 1.1, vdur - 0.05)   # arrive in section 2 mid-scroll

# A late-starting or stalled capture can align marker events near zero (see
# v()'s clamp above), which can push a cut's computed end before its start.
# Force both cuts forward within the actual recording bounds.
cutA = clamp_cut(*cutA, vdur)
cutB = clamp_cut(*cutB, vdur)

clip_cut = cutA[1] - cutA[0]
DUR = clip_cut + (cutB[1] - cutB[0])
# 12s cap: shave the tail evenly if long.
if DUR > 12.0:
    trim = DUR - 12.0
    cutB = (cutB[0], cutB[1] - trim)
    DUR = 12.0

scroll_out = clip_cut + (scroll - cutB[0])
b2 = min(max(scroll_out + 0.45, clip_cut + 1.2), DUR - 2.2)

s1a = props(tiltX=26.0, tiltY=-22.0, roll=1.0, zoom=1.05)
s1a["panX"], s1a["panY"] = aim_pan(s1a, HERO)
s1b = props(tiltX=26.0, tiltY=-26.0, roll=1.0, zoom=0.86)
s1b["panX"], s1b["panY"] = aim_pan(s1b, CTA)
s2a = props(tiltX=24.8, tiltY=17.04, rotateX=-40.0, rotateY=18.0, fov=60.0, zoom=0.8)
s2a["panX"], s2a["panY"] = aim_pan(s2a, PAGE2)
s2b = props(tiltX=34.19, tiltY=15.28, rotateX=-40.0, rotateY=9.0, fov=60.0, zoom=0.74)
s2b["panX"], s2b["panY"] = aim_pan(s2b, PAGE2)
s3a = props(rotateX=-14.0, zoom=0.95)
s3a["panX"], s3a["panY"] = aim_pan(s3a, (0.5, 0.45))
s3b = props(rotateX=-14.0, zoom=1.6)


# --- synthetic cursor track ----------------------------------------------------
# The shoot used CDP input only; the on-screen cursor in the final render is
# drawn from this data. Overwrites any stray real-cursor data Cap recorded.
# Cursor assets are bundled with the skill (assets/cursor_0.png, cursor_2.png,
# assets/cursors.json).
if "cursorLog" in tl:
    with open(os.path.join(ASSETS, "cursors.json")) as f:
        cursors_meta = json.load(f)
    with open(f"{proj}/recording-meta.json") as f:
        meta = json.load(f)
    start_time = meta["segments"][0].get("display", {}).get("start_time", 0.0) or 0.0

    os.makedirs(f"{proj}/content/cursors", exist_ok=True)
    for cid in ("0", "2"):
        src = os.path.join(ASSETS, f"cursor_{cid}.png")
        shutil.copy(src, f"{proj}/content/cursors/cursor_{cid}.png")
    meta["cursors"] = {cid: cursors_meta[cid] for cid in ("0", "2")}
    meta["segments"][0]["cursor"] = "content/segments/segment-0/cursor.json"
    with open(f"{proj}/recording-meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    def ms(t):
        return max(0.0, (t - offset + start_time)) * 1000.0

    moves = [
        {"active_modifiers": [], "cursor_id": "0", "time_ms": ms(m["t"]), "x": m["x"], "y": m["y"]}
        for m in tl["cursorLog"]["moves"]
    ]
    clicks = [
        {"active_modifiers": [], "cursor_num": 1, "cursor_id": "0", "time_ms": ms(c["t"]), "down": c["down"]}
        for c in tl["cursorLog"]["clicks"]
    ]
    with open(f"{proj}/content/segments/segment-0/cursor.json", "w") as f:
        json.dump({"moves": moves, "clicks": clicks}, f)
    print(f"cursor track synthesized: {len(moves)} moves, {len(clicks)} clicks")

os.makedirs(f"{proj}/assets/audio", exist_ok=True)
music_src = resolve_music(music)
dest = f"{proj}/assets/audio/library-{music}.mp3"
shutil.copy(music_src, dest)
mdur = float(subprocess.run(
    ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", dest],
    capture_output=True, text=True).stdout.strip())

config = {
    "aspectRatio": None,
    "background": {
        "source": bg_source,
        "blur": 0.0, "padding": 10.0, "rounding": 7.5, "roundingType": "squircle", "inset": 0,
        "crop": None, "displayPosition": None, "shadow": 73.6,
        "advancedShadow": {"size": 14.4, "opacity": 68.1, "blur": 3.8}, "border": None, "frame": None,
    },
    "timeline": {
        "segments": [
            {"recordingSegment": 0, "timescale": 1.0, "start": cutA[0], "end": cutA[1], "name": None},
            {"recordingSegment": 0, "timescale": 1.0, "start": cutB[0], "end": cutB[1], "name": None},
        ],
        "zoomSegments": [],
        "camera3dSegments": [
            shot(0.0, clip_cut, s1a, s1b, blur(20.0, 0.7, 0.32)),
            shot(clip_cut, b2, s2a, s2b, blur(18.0, 0.72, 0.5)),
            shot(b2, DUR, s3a, s3b, blur(19.0, 0.67, 0.42)),
        ],
        "audioSegments": [{
            "start": 0.0, "end": DUR, "track": 0,
            "path": f"assets/audio/library-{music}.mp3",
            "name": music, "enabled": True, "trimStart": 0.0,
            "volumeDb": 0.0, "fadeIn": 0.5, "fadeOut": 1.5, "duration": mdur,
        }],
    },
}
with open(f"{proj}/project-config.json", "w") as f:
    json.dump(config, f, indent=1)
print(f"{slug}: story={story} dur={DUR:.2f} cut={clip_cut:.2f} b2={b2:.2f} offset={offset:.2f} grad={config['background']['source']}")

out_mp4 = os.path.join(outDir, f"{slug}-demo.mp4")


def source_fps(path):
    """Dominant capture rate (mode of instantaneous fps). Window capture is VFR:
    a few long stall gaps (page nav, heavy animation) drag the mean down, so the
    mean is the wrong number to export at. The mode is the real rate the smooth
    sections were captured at; matching it avoids resample judder."""
    try:
        import re as _re
        from collections import Counter
        pts = subprocess.run(
            ["ffprobe", "-v", "quiet", "-select_streams", "v",
             "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
            capture_output=True, text=True).stdout.replace(",", " ").split()
        times = [float(x) for x in pts if x.strip()]
        rates = Counter()
        for a, b in zip(times, times[1:]):
            d = b - a
            if d > 1e-6:
                rates[round(1.0 / d)] += 1
        if rates:
            return max(2, min(60, rates.most_common(1)[0][0]))
    except Exception:
        pass
    try:
        import re as _re
        meta = subprocess.run(
            ["ffprobe", "-v", "quiet", "-count_frames", "-select_streams", "v",
             "-show_entries", "stream=nb_read_frames", "-show_entries", "format=duration",
             "-of", "csv=p=0", path], capture_output=True, text=True).stdout
        nums = [x for x in _re.split(r"[,\n]", meta) if x.strip()]
        return max(2, min(60, round(int(nums[0]) / float(nums[1]))))
    except Exception:
        return 60


fps = str(source_fps(video))
cmd = [CAP, "export", proj, "-o", out_mp4, "--fps", fps]
if args.quality == "4k":
    cmd += ["--resolution", "3840x2160", "--quality", "maximum", "--optimize-filesize"]
elif args.quality == "hd":
    cmd += ["--quality", "maximum"]
else:
    cmd += ["--quality", "maximum", "--optimize-filesize"]
res = subprocess.run(cmd, capture_output=True, text=True)
if res.returncode != 0:
    sys.stderr.write(res.stdout or "")
    sys.stderr.write(res.stderr or "")
    raise SystemExit(f"cap export failed (exit {res.returncode})")
print(f"exported {slug}-demo.mp4")
print(out_mp4)
