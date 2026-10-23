#!/usr/bin/env python3
import argparse
import cmath
import hashlib
import json
import math
import os
import queue
import random
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np
from Xlib import X
from Xlib import display as xdisplay

import playback
import scenarios
import sideinfo

HERE = Path(__file__).resolve().parent
PAGES = HERE / "pages"
MANIFEST = HERE / "manifest.json"
CORPUS = Path(os.environ.get("CAPCODEC_CORPUS", "/home/ubuntu/work/corpus"))
CACHE = Path(os.environ.get("CAPCODEC_CACHE", "/home/ubuntu/work/cache/capcodec-corpus"))
FFMPEG = os.environ.get("CAPCODEC_FFMPEG", "/home/ubuntu/tools/bin/ffmpeg")
FFPROBE = os.environ.get("CAPCODEC_FFPROBE", str(Path(FFMPEG).with_name("ffprobe")))
CHROME_CHANNEL = "chrome"

LOCK_TARGET_MS = 25.0
LOCK_TOLERANCE_MS = 4.5
LOCK_MAX_ATTEMPTS = 40
LOCK_MIN_LEAD_S = 1.5
LOCK_TAIL_FRAMES = 45
SOURCE_CAPTURE_RUNS = 3


@dataclass(frozen=True)
class VideoSource:
    key: str
    title: str
    url: str
    zip_sha256: str
    member: str
    sha256: str
    fps: int
    segment_start_s: float
    segment_frames: int
    cut_s: float
    licence: str
    licence_url: str
    attribution: str
    homepage: str

    @property
    def segment_name(self):
        return f"{Path(self.member).stem}_from{self.segment_start_s:.3f}s_{self.segment_frames}f.mp4"

    @property
    def cut_frame(self):
        return round((self.cut_s - self.segment_start_s) * self.fps)


BIG_BUCK_BUNNY = VideoSource(
    key="big_buck_bunny_sunflower",
    title="Big Buck Bunny (2013 'sunflower' edition, 1920x1080, 30 fps, H.264 High, ~3 Mbit/s)",
    url="https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip",
    zip_sha256="e320fef389ec749117d0c1583945039266a40f25483881c2ff0d33207e62b362",
    member="bbb_sunflower_1080p_30fps_normal.mp4",
    sha256="ae51005850b0ff757fe60c3dd7a12d754d3cd2397d87d939b55235e457f97658",
    fps=30,
    segment_start_s=16.3,
    segment_frames=1325,
    cut_s=27.466667,
    licence="CC BY 3.0",
    licence_url="https://creativecommons.org/licenses/by/3.0/",
    attribution="Big Buck Bunny, (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org",
    homepage="https://peach.blender.org/",
)


@dataclass
class Clip:
    name: str
    page: str
    description: str
    tags: list
    duration: int = 40
    fps: int = 30
    width: int = 1920
    height: int = 1080
    dsf: int = 1
    display: str = ":99"
    start_pointer: tuple = (1500, 800)
    prepare_js: str = ""
    settle_s: float = 1.2
    seed: int = 1
    threads: int = 2
    draw_mouse: bool = True
    source: VideoSource | None = None
    extra: dict = field(default_factory=dict)

    @property
    def frames(self):
        return self.duration * self.fps


CLIPS = [
    Clip(
        "slow_typing",
        "docs.html",
        "Google-Docs-like editor, 15px Liberation Sans body text. Human typing via xdotool (120-250 ms per keystroke, "
        "word-level pauses, two typo corrections with BackSpace), one wheel notch down/up, a few mouse moves and clicks.",
        ["typing", "text", "light", "docs", "low-motion"],
        start_pointer=(1380, 640),
        seed=11,
    ),
    Clip(
        "code_editor",
        "code.html",
        "VS Code Light+ workbench on CPython difflib.py, 13px JetBrains Mono. Types a new Python function with "
        "auto-indent and IntelliSense popups, saves, then wheel-scrolls (single notches and bursts), PageDown x3, "
        "arrow-key caret moves, a click and Ctrl+Home.",
        ["code", "typing", "scroll", "text", "light", "monospace"],
        start_pointer=(1250, 700),
        seed=12,
    ),
    Clip(
        "text_scroll",
        "article.html",
        "Wikipedia (Vector 2022)-like article with images, tables and references. Wheel scrolling at varying speeds "
        "(single smooth notches, fast flicks up and down), link-preview hovers, a drag text selection, a 4.2 s eased "
        "smooth scroll and keyboard PageDown.",
        ["scroll", "text", "light", "web", "images"],
        start_pointer=(1300, 600),
        seed=13,
    ),
    Clip(
        "slides",
        "slides.html",
        "16:9 presentation deck (charts, photo with grain, tables, timeline). Advances every ~3 s with cuts, 600 ms "
        "fades and 650 ms push/cover slide-ins, incl. bullet builds, one step back, and a couple of pointer moves.",
        ["slides", "transitions", "fades", "light"],
        start_pointer=(1600, 880),
        seed=14,
    ),
    Clip(
        "busy_ui",
        "board.html",
        "Dense Linear/Notion-like issue board. The pointer moves almost constantly along curved paths: hover states, "
        "tooltips, filter/card/display menus, a details side panel, three card drags with toasts, vertical column "
        "scroll and horizontal board scroll.",
        ["ui", "pointer", "menus", "drag", "scroll", "light"],
        start_pointer=(900, 300),
        seed=15,
    ),
    Clip(
        "dashboard",
        "dashboard.html",
        "Analytics dashboard: 11-12px tables, KPI tiles with sparklines, numbers updating every second with flash "
        "highlights, two canvas line charts shifting every second (420 ms animation), live event feed; pointer sweeps "
        "chart crosshairs/tooltips and hovers table rows.",
        ["dashboard", "small-text", "charts", "animation", "light"],
        start_pointer=(1500, 560),
        prepare_js="capStart()",
        settle_s=2.5,
        seed=16,
    ),
    Clip(
        "dark_mode",
        "dark.html",
        "VS Code Dark+ on zlib inflate.c with an integrated terminal streaming libFuzzer logs (auto-scrolling). "
        "Ctrl+C, typed git status / make test (build log), a one-line C edit + save, editor wheel scroll, then restarts "
        "the fuzzer.",
        ["code", "dark", "terminal", "scroll", "typing", "monospace"],
        start_pointer=(1500, 420),
        prepare_js="capStart()",
        settle_s=2.0,
        seed=17,
    ),
    Clip(
        "idle",
        "idle.html",
        "Desktop-like static scene (PDF viewer window, dock, menu bar). Only the menu-bar clock ticks each second, "
        "three notification toasts slide in/out, and the pointer moves four times.",
        ["idle", "static", "text", "toasts"],
        duration=60,
        start_pointer=(1240, 760),
        seed=18,
    ),
    Clip(
        "webcam_overlay",
        "slides.html?webcam=1",
        "Slide deck with a 320px circular webcam bubble rendered on a canvas at 30 fps (moving gradient, "
        "head-and-shoulders, blink/talk, per-frame sensor noise). The bubble is dragged to four positions; slides "
        "advance every ~4 s.",
        ["webcam", "noise", "slides", "drag", "overlay"],
        start_pointer=(1400, 500),
        seed=19,
    ),
    Clip(
        "busy_ui_60fps",
        "board.html",
        "busy_ui scenario variant at 60 fps: continuous curved pointer motion and hovers, filter and card menus, a "
        "card drag with toast, column wheel scroll.",
        ["ui", "pointer", "60fps", "menus", "drag", "light"],
        duration=20,
        fps=60,
        start_pointer=(900, 300),
        seed=20,
        threads=3,
    ),
    Clip(
        "code_4k",
        "code.html",
        "3840x2160 (device scale factor 2) VS Code Light+ on difflib.py: types a short function, saves, wheel scroll, "
        "PageDown, caret moves.",
        ["code", "4k", "hidpi", "typing", "scroll", "monospace"],
        duration=20,
        width=3840,
        height=2160,
        dsf=2,
        display=":98",
        start_pointer=(2500, 1400),
        seed=21,
        threads=3,
    ),
    Clip(
        "full_motion",
        "video.html",
        "Natural video full screen (worst case for a screen encoder): Big Buck Bunny 1080p30 (Blender Foundation, "
        "CC BY 3.0) played by Chrome in a <video> filling the viewport (object-fit: cover, autoplay muted loop, no "
        "controls), source 27.47-57.43 s from a shot cut: slow camera push-in on the burrow under the tree with "
        "wind-blown grass and foliage, the dark burrow close-up as the bunny emerges, the bunny stretching in the "
        "sunlit meadow. No input; pointer parked bottom-right, hidden (cursor: none, -draw_mouse 0).",
        ["video", "natural", "full-motion", "camera-motion", "fine-detail", "worst-case"],
        duration=30,
        start_pointer=(1919, 1079),
        settle_s=0.5,
        seed=22,
        threads=3,
        draw_mouse=False,
        source=BIG_BUCK_BUNNY,
    ),
]
CLIP_BY_NAME = {c.name: c for c in CLIPS}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def write_json(path, obj):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")
    tmp.replace(path)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def framemd5(path, count=None, pix_fmt=None):
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path), "-map", "0:v:0"]
    if count is not None:
        cmd += ["-frames:v", str(count)]
    if pix_fmt:
        cmd += ["-pix_fmt", pix_fmt]
    out = subprocess.run(cmd + ["-f", "framemd5", "-"], capture_output=True, text=True, check=True).stdout
    return [ln.split(",")[-1].strip() for ln in out.splitlines() if ln and not ln.startswith("#")]


def download(url, dest):
    part = Path(str(dest) + ".part")
    for attempt in range(4):
        try:
            log(f"downloading {url}")
            urllib.request.urlretrieve(url, part)
            part.replace(dest)
            return
        except OSError as e:
            log(f"download failed ({e}); retrying")
            time.sleep(4 * 2**attempt)
    raise RuntimeError(f"could not download {url}")


def prepare_video(src):
    """Fetch the source into CACHE once and stream-copy the segment the page plays."""
    CACHE.mkdir(parents=True, exist_ok=True)
    mp4 = CACHE / src.member
    if not mp4.exists() or sha256(mp4) != src.sha256:
        z = CACHE / (src.member + ".zip")
        if not z.exists() or sha256(z) != src.zip_sha256:
            download(src.url, z)
            if sha256(z) != src.zip_sha256:
                raise RuntimeError(f"{z}: sha256 mismatch")
        with zipfile.ZipFile(z) as zf, zf.open(src.member) as fin, open(str(mp4) + ".part", "wb") as fout:
            shutil.copyfileobj(fin, fout, 1 << 20)
        Path(str(mp4) + ".part").replace(mp4)
        if sha256(mp4) != src.sha256:
            raise RuntimeError(f"{mp4}: sha256 mismatch")
    seg = CACHE / src.segment_name
    meta_path = seg.with_suffix(".json")
    meta = json.load(open(meta_path)) if meta_path.exists() else {}
    if seg.exists() and meta.get("sha256") == sha256(seg) and meta.get("source_sha256") == src.sha256:
        return meta
    log(f"cutting {seg.name} (stream copy) and verifying it against the source")
    probe = json.loads(
        subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=start_time", "-of", "json", str(mp4)],
            capture_output=True, text=True, check=True,
        ).stdout
    )["streams"][0]  # fmt: skip
    first = round(src.segment_start_s * src.fps) - round(float(probe["start_time"]) * src.fps)
    tmp = seg.with_suffix(".part.mp4")
    subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(src.segment_start_s), "-i", str(mp4),
         "-map", "0:v:0", "-c", "copy", "-an", "-frames:v", str(src.segment_frames), "-movflags", "+faststart", str(tmp)],
        check=True,
    )  # fmt: skip
    got = framemd5(tmp)
    want = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(mp4), "-map", "0:v:0",
         "-vf", f"select=between(n\\,{first}\\,{first + src.segment_frames - 1})", "-fps_mode", "passthrough",
         "-f", "framemd5", "-"],
        capture_output=True, text=True, check=True,
    ).stdout  # fmt: skip
    want = [ln.split(",")[-1].strip() for ln in want.splitlines() if ln and not ln.startswith("#")]
    if len(got) != src.segment_frames or got != want:
        raise RuntimeError(f"{tmp}: decoded segment differs from source frames {first}..")
    tmp.replace(seg)
    meta = {
        "file": str(seg),
        "sha256": sha256(seg),
        "source_sha256": src.sha256,
        "frames": src.segment_frames,
        "source_first_frame_index": first,
        "source_first_pts_s": src.segment_start_s,
        "method": "ffmpeg -ss START -i SOURCE -map 0:v:0 -c copy -an (starts on a keyframe; no re-encode); every "
        "decoded frame verified identical (framemd5) to the matching source frame",
    }
    write_json(meta_path, meta)
    return meta


def source_features(src):
    meta = prepare_video(src)
    cache = CACHE / f"{Path(src.segment_name).stem}.features.{meta['sha256'][:12]}.npy"
    if cache.exists():
        return np.load(cache)
    feat = playback.features(playback.luma_frames(FFMPEG, CACHE / src.segment_name, yuv_bt709=True))
    if len(feat) != src.segment_frames:
        raise RuntimeError(f"decoded {len(feat)} segment frames, expected {src.segment_frames}")
    np.save(cache, feat)
    return feat


def source_dirty(src):
    meta = prepare_video(src)
    cache = CACHE / f"{Path(src.segment_name).stem}.tiledirty.{meta['sha256'][:12]}.npy"
    if cache.exists():
        return np.load(cache)
    dirty = playback.source_tile_dirty(FFMPEG, CACHE / src.segment_name, 1920, 1080)
    if len(dirty) != src.segment_frames:
        raise RuntimeError(f"decoded {len(dirty)} segment frames, expected {src.segment_frames}")
    np.save(cache, dirty)
    return dirty


def circular_phase(values_ms, period_ms):
    z = sum(cmath.exp(2j * math.pi * (v % period_ms) / period_ms) for v in values_ms) / len(values_ms)
    return (cmath.phase(z) / (2 * math.pi) * period_ms) % period_ms, abs(z)


def wrap(x, period):
    return (x + period / 2) % period - period / 2


def display_number(disp):
    return int(disp.lstrip(":").split(".")[0])


def screen_size(disp):
    try:
        d = xdisplay.Display(disp)
    except Exception:
        return None
    s = d.screen()
    size = (s.width_in_pixels, s.height_in_pixels)
    d.close()
    return size


def xvfb_pid(disp):
    lock = Path(f"/tmp/.X{display_number(disp)}-lock")
    try:
        return int(lock.read_text().strip())
    except (OSError, ValueError):
        return None


class XvfbManager:
    def __init__(self):
        self.started = {}

    def ensure(self, disp, width, height):
        if disp == ":1":
            raise RuntimeError("display :1 is reserved for VNC")
        size = screen_size(disp)
        if size is not None:
            if size != (width, height):
                raise RuntimeError(f"{disp} is running at {size}, need {width}x{height}")
            return
        log(f"starting Xvfb {disp} {width}x{height}")
        proc = subprocess.Popen(
            ["Xvfb", disp, "-screen", "0", f"{width}x{height}x24", "-nolisten", "tcp", "-dpi", "96", "-noreset"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.started[disp] = proc
        for _ in range(100):
            if screen_size(disp) == (width, height):
                return
            time.sleep(0.1)
        raise RuntimeError(f"Xvfb {disp} did not come up")

    def stop_all(self):
        for disp, proc in self.started.items():
            log(f"stopping Xvfb {disp} (pid {proc.pid})")
            os.kill(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.kill(proc.pid, signal.SIGKILL)
        self.started.clear()


def renice(pids):
    pids = [str(p) for p in pids if p]
    if pids:
        subprocess.run(["sudo", "-n", "renice", "-n", "-10", "-p", *pids], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def chrome_thread_ids(profile):
    """Every thread of the Chrome instance using this profile (renice -p is per thread on Linux)."""
    flag = f"--user-data-dir={profile}".encode()
    children = {}
    roots = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            ppid = int((d / "stat").read_text().rsplit(")", 1)[1].split()[1])
            cmdline = (d / "cmdline").read_bytes().split(b"\0")
        except (OSError, IndexError, ValueError):
            continue
        children.setdefault(ppid, []).append(int(d.name))
        if flag in cmdline:
            roots.append(int(d.name))
    pids, todo = set(), list(roots)
    while todo:
        p = todo.pop()
        if p not in pids:
            pids.add(p)
            todo.extend(children.get(p, []))
    tids = []
    for p in sorted(pids):
        try:
            tids += [int(t.name) for t in Path(f"/proc/{p}/task").iterdir()]
        except OSError:
            pass
    return sorted(pids), tids


def calibrate(clip, workdir):
    """Measure x11grab per-grab latency and ffmpeg's start-to-first-frame delay."""
    out = workdir / "calib.txt"
    cmd = [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "x11grab", "-framerate", "1000", "-video_size", f"{clip.width}x{clip.height}", "-draw_mouse", "1",
        "-use_wallclock_as_timestamps", "1", "-i", clip.display, "-copyts", "-fps_mode", "passthrough",
        "-enc_time_base:v", "demux", "-frames:v", "120", "-stats_enc_pre", str(out), "-stats_enc_pre_fmt", "{n} {pts}",
        "-f", "null", "-",
    ]  # fmt: skip
    t_start = time.time()
    subprocess.run(cmd, check=True)
    ts = [int(line.split()[1]) for line in out.read_text().split("\n") if line.strip()]
    gaps = [(b - a) / 1000.0 for a, b in zip(ts[10:], ts[11:])]
    return {"grab_latency_ms": round(statistics.median(gaps), 3), "startup_ms": round(ts[0] / 1000.0 - t_start * 1000.0, 1)}


class PageBridge:
    def __init__(self, page):
        self.page = page
        self.q = queue.Queue()

    def call(self, expr, arg=None, timeout=15):
        ev = threading.Event()
        box = {}
        self.q.put((expr, arg, ev, box))
        if not ev.wait(timeout):
            raise TimeoutError(f"page call timed out: {expr[:80]}")
        if "err" in box:
            raise box["err"]
        return box["val"]

    def pump(self, ms=10):
        while True:
            try:
                expr, arg, ev, box = self.q.get_nowait()
            except queue.Empty:
                break
            try:
                box["val"] = self.page.evaluate(expr, arg)
            except Exception as e:
                box["err"] = e
            ev.set()
        self.page.wait_for_timeout(ms)


def chrome_windows(disp):
    r = subprocess.run(
        ["xdotool", "search", "--onlyvisible", "--class", "Google-chrome"],
        capture_output=True,
        text=True,
        env={"DISPLAY": disp, "PATH": "/usr/bin:/bin"},
    )
    return [w for w in r.stdout.split() if w.strip()]


def fit_window(clip, page):
    env = {"DISPLAY": clip.display, "PATH": "/usr/bin:/bin"}
    want = [clip.width // clip.dsf, clip.height // clip.dsf, clip.dsf]
    got = None
    for _ in range(40):
        for w in chrome_windows(clip.display):
            subprocess.run(["xdotool", "windowmove", w, "0", "0", "windowsize", w, str(clip.width), str(clip.height)], env=env)
        page.wait_for_timeout(150)
        got = page.evaluate("[innerWidth, innerHeight, devicePixelRatio]")
        if got == want:
            wins = chrome_windows(clip.display)
            if wins:
                try:
                    subprocess.run(["xdotool", "windowfocus", "--sync", wins[-1]], env=env, timeout=5)
                except subprocess.TimeoutExpired:
                    log("xdotool windowfocus timed out")
            return got
        page.wait_for_timeout(100)
    raise RuntimeError(f"window did not reach {want}, got {got}")


def focus_largest_chrome_window(disp):
    d = xdisplay.Display(disp)
    try:
        best = None
        for wid in chrome_windows(disp):
            w = d.create_resource_object("window", int(wid))
            g = w.get_geometry()
            if best is None or g.width * g.height > best[0]:
                best = (g.width * g.height, w)
        if best is None:
            return False
        d.set_input_focus(best[1], X.RevertToParent, X.CurrentTime)
        d.sync()
        return True
    finally:
        d.close()


def ensure_keyboard_focus(clip, page):
    """Without a window manager Chrome reports document.hasFocus() but drops X key
    events until the first click; Page.bringToFront activates the web contents.
    A real Shift press verifies it before recording."""
    env = {"DISPLAY": clip.display, "PATH": "/usr/bin:/bin"}
    page.evaluate(
        "() => { window.__capShiftSeen = 0; addEventListener('keydown', (e) => { if (e.key === 'Shift') window.__capShiftSeen++; }, true); }"
    )

    def probe():
        before = page.evaluate("window.__capShiftSeen")
        subprocess.run(["xdotool", "key", "shift"], env=env, timeout=5)
        for _ in range(20):
            page.wait_for_timeout(25)
            if page.evaluate("window.__capShiftSeen") > before:
                return True
        return False

    page.bring_to_front()
    if probe():
        return "bring_to_front"
    if focus_largest_chrome_window(clip.display) and probe():
        return "bring_to_front+XSetInputFocus"
    raise RuntimeError("page does not receive X keyboard events")


def parse_progress(path):
    last = {}
    try:
        text = Path(path).read_text()
    except OSError:
        return last
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            last[k.strip()] = v.strip()
    return last


def frame_timing(ts_us, fps):
    nominal = 1000.0 / fps
    ms = [t / 1000.0 for t in ts_us]
    iv = [b - a for a, b in zip(ms, ms[1:])]
    late = [x for x in iv if x > 1.5 * nominal]
    catchup = [x for x in iv if x < 0.5 * nominal]
    missed = sum(max(0, round(x / nominal) - 1) for x in late)
    return {
        "nominal_interval_ms": round(nominal, 3),
        "mean_interval_ms": round(statistics.mean(iv), 3),
        "stdev_interval_ms": round(statistics.pstdev(iv), 3),
        "min_interval_ms": round(min(iv), 3),
        "max_interval_ms": round(max(iv), 3),
        "late_grabs": len(late),
        "catchup_grabs": len(catchup),
        "missed_slots": missed,
        "wall_duration_ms": round(ms[-1] - ms[0] + nominal, 3),
    }


def chrome_args(clip):
    return [
        "--kiosk",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints,AutofillServerCommunication,DialMediaRouteProvider",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-pings",
        "--password-store=basic",
        "--force-color-profile=srgb",
        "--allow-file-access-from-files",
        "--window-position=0,0",
        f"--window-size={clip.width},{clip.height}",
        f"--force-device-scale-factor={clip.dsf}",
    ]


def ffmpeg_cmd(clip, frames, work):
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-y", "-loglevel", "info",
        "-thread_queue_size", "64",
        "-f", "x11grab", "-framerate", str(clip.fps), "-video_size", f"{clip.width}x{clip.height}",
        "-draw_mouse", "1" if clip.draw_mouse else "0", "-use_wallclock_as_timestamps", "1", "-i", clip.display,
        "-copyts", "-fps_mode", "passthrough", "-enc_time_base:v", "demux",
        "-frames:v", str(frames),
        "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", "-g", str(clip.fps * 5), "-threads", str(clip.threads),
        "-stats_enc_pre", str(work / "frames.txt"), "-stats_enc_pre_fmt", "{n} {tb} {pts}",
        "-progress", str(work / "progress.txt"),
        str(work / "raw.mkv"),
    ]  # fmt: skip


def read_frame_pts_ms(path):
    try:
        lines = [ln.split() for ln in Path(path).read_text().splitlines() if ln.strip()]
    except OSError:
        return []
    out = []
    for ln in lines:
        if len(ln) == 3:
            num, den = (int(x) for x in ln[1].split("/"))
            out.append(int(ln[2]) * 1000.0 * num / den)
    return out


def phase_lock(clip, page, work, launch):
    """Relaunch ffmpeg until its x11grab grid sits LOCK_TARGET_MS after Chrome's video frame presentation phase.

    x11grab grabs on a fixed grid (its start time + k/fps); the start time is random and pausing ffmpeg does not
    move it. Chrome's 30 fps presentations keep a stable phase (requestVideoFrameCallback expectedDisplayTime E,
    drift ~1.6 ms per 40 s) and the framebuffer switches to frame k+1 3.5-14 ms after E(k) (1000 fps probes;
    content matching shows frame k is already on screen ~10 ms before E(k)), so a grid at E + 25 ms sits mid-way
    between two switches. Each attempt is measured from ffmpeg's per-frame wallclock stats.
    """
    src = clip.source
    period = 1000.0 / clip.fps
    cut_media = src.cut_frame / src.fps
    attempts = []
    restarts = 0
    while len(attempts) < LOCK_MAX_ATTEMPTS:
        st = page.evaluate("capStats()")
        if st["current_time"] > cut_media - LOCK_MIN_LEAD_S - 1.0 or st["paused"]:
            restarts += 1
            log(f"{clip.name}: media time {st['current_time']:.2f}s too close to the cut, restarting playback")
            page.evaluate("capRestart()")
            page.wait_for_function("window.capReady === true", timeout=30000)
            continue
        frames = math.ceil((cut_media - st["current_time"]) * clip.fps) + clip.frames + LOCK_TAIL_FRAMES
        ff = launch(frames)
        pts = []
        deadline = time.time() + 5
        while time.time() < deadline and ff.poll() is None:
            pts = read_frame_pts_ms(work / "frames.txt")
            if len(pts) >= 16:
                break
            page.wait_for_timeout(20)
        if ff.poll() is not None:
            raise RuntimeError(f"ffmpeg exited with {ff.returncode} during phase lock; see {work / 'ffmpeg.log'}")
        if len(pts) < 16:
            raise RuntimeError("ffmpeg produced no frame stats during phase lock")
        grid, grid_r = circular_phase(pts[-8:], period)
        recent = page.evaluate("capRecentFrames(30)")
        vid, vid_r = circular_phase([r["expected_display"] for r in recent], period)
        delta = wrap(grid - vid - LOCK_TARGET_MS, period)
        media_now = page.evaluate("capStats().current_time")
        ok = abs(delta) <= LOCK_TOLERANCE_MS and grid_r > 0.99 and vid_r > 0.98 and media_now < cut_media - LOCK_MIN_LEAD_S
        attempts.append(
            {
                "frames_requested": frames,
                "grid_phase_ms": round(grid, 3),
                "grid_R": round(grid_r, 5),
                "video_phase_ms": round(vid, 3),
                "video_R": round(vid_r, 5),
                "delta_ms": round(delta, 3),
                "media_time_s": round(media_now, 3),
                "accepted": ok,
            }
        )
        if ok:
            ref = recent[-1]
            e_cut = ref["expected_display"] + (src.cut_frame - round(ref["media_time"] * src.fps)) * period
            first_grab = e_cut - period + LOCK_TARGET_MS + wrap(pts[-1] - e_cut - LOCK_TARGET_MS, period)
            log(f"{clip.name}: phase locked after {len(attempts)} attempt(s), delta {delta:+.1f} ms, lead {e_cut / 1000 - time.time():.1f}s")
            lock = {
                "target_ms": LOCK_TARGET_MS,
                "tolerance_ms": LOCK_TOLERANCE_MS,
                "playback_restarts": restarts,
                "attempts": attempts,
                "predicted_cut_display_ms": round(e_cut, 3),
                "predicted_first_frame_ms": round(first_grab, 3),
                "frames_total": frames,
            }
            return ff, lock
        os.kill(ff.pid, signal.SIGKILL)
        ff.wait(timeout=10)
    raise RuntimeError(f"no phase lock after {len(attempts)} attempts: {attempts[-5:]}")


def capture(clip, xvfb):
    from playwright.sync_api import sync_playwright

    work = CORPUS / ".work" / clip.name
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    video_meta = prepare_video(clip.source) if clip.source else None
    xvfb.ensure(clip.display, clip.width, clip.height)
    calib = calibrate(clip, work)
    log(f"{clip.name}: grab latency {calib['grab_latency_ms']} ms, ffmpeg startup {calib['startup_ms']} ms")

    page_records = []
    actions = []
    actions_lock = threading.Lock()

    def action_log(kind, **kw):
        rec = {"k": "action", "t": round(time.time() * 1000.0, 3), "type": kind, **kw}
        with actions_lock:
            actions.append(rec)

    ff_log = work / "ffmpeg.log"
    pointer_file = work / "pointer.jsonl"
    ff_cmd = ffmpeg_cmd(clip, clip.frames, work)
    url = (PAGES / clip.page.split("?")[0]).as_uri() + (("?" + clip.page.split("?", 1)[1]) if "?" in clip.page else "")
    info = {"url": url, "calibration": calib}
    if video_meta:
        info["source_segment"] = video_meta

    def launch(frames):
        for name in ("raw.mkv", "frames.txt", "progress.txt"):
            (work / name).unlink(missing_ok=True)
        cmd = ffmpeg_cmd(clip, frames, work)
        with open(ff_log, "w") as flog:
            proc = subprocess.Popen(cmd, stdout=flog, stderr=subprocess.STDOUT, start_new_session=True)
        renice([proc.pid, xvfb_pid(clip.display)])
        return proc
    scenario_state = {"error": None, "truncated": None, "start_wall": None, "end_wall": None}
    profile = work / "profile"
    sampler = None
    ff = None

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            str(profile),
            channel=CHROME_CHANNEL,
            headless=False,
            no_viewport=True,
            args=chrome_args(clip),
            ignore_default_args=["--enable-automation"],
            env={**os.environ, "DISPLAY": clip.display},
        )
        try:
            info["chrome_version"] = ctx.browser.version if ctx.browser else None
            ctx.expose_binding("__capReport", lambda source, batch: page_records.extend(batch))
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
            if video_meta:
                page.add_init_script(
                    "window.capVideoSrc = " + json.dumps(Path(video_meta["file"]).as_uri()) + ";"
                )
            page.goto(url)
            info["viewport"] = fit_window(clip, page)
            page.wait_for_function("window.capReady === true", timeout=15000)
            inp_rng = random.Random(clip.seed)
            inp = scenarios.Input(clip.display, action_log, inp_rng)
            inp.warp(*clip.start_pointer)
            if clip.prepare_js:
                page.evaluate(clip.prepare_js)
            page.wait_for_timeout(int(clip.settle_s * 1000))
            info["text_regions_css"] = page.evaluate("window.capTextRegions ? capTextRegions() : []")
            info["has_focus"] = page.evaluate("document.hasFocus()")
            info["keyboard_focus"] = ensure_keyboard_focus(clip, page)
            bridge = PageBridge(page)

            sampler = subprocess.Popen(
                [sys.executable, str(HERE / "pointer_sampler.py"), "--display", clip.display, "--hz", "240", "--out", str(pointer_file)],
                start_new_session=True,
            )
            for _ in range(100):
                if pointer_file.exists() and pointer_file.stat().st_size > 0:
                    break
                page.wait_for_timeout(20)

            if clip.source:
                pids, tids = chrome_thread_ids(profile)
                renice(tids)
                info["reniced_chrome"] = {"processes": len(pids), "threads": len(tids)}
                info["video_stats_before"] = page.evaluate("capStats()")
                ff, info["phase_lock"] = phase_lock(clip, page, work, launch)
                ff_cmd = ffmpeg_cmd(clip, info["phase_lock"]["frames_total"], work)
                t0 = info["phase_lock"]["predicted_first_frame_ms"] / 1000.0
            else:
                t_launch = time.time()
                ff = launch(clip.frames)
                t0 = t_launch + calib["startup_ms"] / 1000.0
            sctx = scenarios.Ctx(clip, inp, random.Random(clip.seed * 7919), bridge.call, t0, action_log)

            def run_scenario():
                scenario_state["start_wall"] = time.time()
                try:
                    scenarios.SCENARIOS[clip.name](sctx)
                except scenarios.ScenarioOutOfTime as e:
                    scenario_state["truncated"] = str(e)
                    action_log("scenario_truncated", reason=str(e))
                except Exception as e:
                    scenario_state["error"] = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
                    action_log("scenario_error", error=str(e))
                finally:
                    inp.release_all()
                    scenario_state["end_wall"] = time.time()
                    action_log("scenario_end")

            th = threading.Thread(target=run_scenario, name="scenario", daemon=True)
            action_log("scenario_start")
            th.start()
            deadline = time.time() + clip.duration + 60
            while (th.is_alive() or ff.poll() is None) and time.time() < deadline:
                bridge.pump(10)
            if ff.poll() is None:
                ff.send_signal(signal.SIGINT)
                ff.wait(timeout=20)
                raise RuntimeError("ffmpeg did not finish in time")
            th.join(timeout=10)
            if clip.source:
                info["video_stats_after"] = page.evaluate("capStats()")
            page.evaluate("cap.flush()")
            for _ in range(30):
                bridge.pump(10)
            info["console"] = console[:50]
        finally:
            if sampler is not None and sampler.poll() is None:
                os.kill(sampler.pid, signal.SIGTERM)
                sampler.wait(timeout=10)
            if ff is not None and ff.poll() is None:
                os.kill(ff.pid, signal.SIGINT)
                ff.wait(timeout=20)
            ctx.close()

    if ff.returncode != 0:
        raise RuntimeError(f"ffmpeg exited with {ff.returncode}; see {ff_log}")
    if scenario_state["error"]:
        log(f"{clip.name}: SCENARIO ERROR\n{scenario_state['error']}")
    return finalize(clip, work, info, scenario_state, page_records, actions, ff_cmd)


def trim_to_cut(clip, work, ts_us, page_records, lock):
    """Find the raw frame that first shows the source cut frame and re-encode the clip from it (bit-exact)."""
    src = clip.source
    period = 1000.0 / clip.fps
    ms = [t / 1000.0 for t in ts_us]

    def nearest(t):
        return min(range(len(ms)), key=lambda i: abs(ms[i] - t))

    lock_index = nearest(lock["predicted_first_frame_ms"])
    at_cut = [
        r for r in page_records
        if r.get("type") == "video_frame" and r["expected_display"] >= ms[0] - period
        and round(r["media_time"] * src.fps) == src.cut_frame
    ]  # fmt: skip
    rvfc_index = nearest(at_cut[0]["expected_display"] - period + LOCK_TARGET_MS) if at_cut else None
    center = rvfc_index if rvfc_index is not None else lock_index
    seg = source_features(src)
    cap = playback.features(playback.luma_frames(FFMPEG, work / "raw.mkv", count=min(center + 45, len(ms))))
    lo = max(0, center - 60)
    window = cap[lo:]
    offset = playback.find_offset(window, seg, probe=range(center - lo - 6, center - lo + 6))
    js, chosen, other = playback.match(window, seg, offset)
    hits = [k for k, j in enumerate(js) if j == src.cut_frame]
    if not hits:
        raise RuntimeError(f"{clip.name}: no raw frame near {center} shows source frame {src.cut_frame}: {js[-50:]}")
    k = hits[0]
    first = lo + k
    if first + clip.frames > len(ms):
        raise RuntimeError(f"{clip.name}: cut at raw frame {first} leaves fewer than {clip.frames} frames")
    trim = work / "trim.mkv"
    subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(work / "raw.mkv"), "-map", "0:v:0",
         "-vf", f"select=between(n\\,{first}\\,{first + clip.frames - 1})", "-fps_mode", "passthrough",
         "-frames:v", str(clip.frames), "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0",
         "-g", str(clip.fps * 5), "-threads", "0", str(trim)],
        check=True,
    )  # fmt: skip
    want = framemd5(work / "raw.mkv", count=first + clip.frames, pix_fmt="bgr0")[first:]
    got = framemd5(trim, pix_fmt="bgr0")
    if got != want:
        raise RuntimeError(f"{clip.name}: trimmed clip is not bit-exact to raw frames {first}..")
    log(f"{clip.name}: cut at raw frame {first} (rVFC {rvfc_index}, lock {lock_index}), trim verified bit-exact")
    return {
        "cut_source_s": src.cut_s,
        "cut_segment_frame": src.cut_frame,
        "raw_frames": len(ms),
        "first_raw_frame": first,
        "rvfc_predicted_raw_frame": rvfc_index,
        "lock_predicted_raw_frame": lock_index,
        "segment_frames_around_cut": js[max(0, k - 4) : k + 5],
        "match_distance_at_cut": round(chosen[k], 4),
        "next_best_distance_at_cut": round(other[k], 4),
        "method": "raw frames mapped to segment frames by downscaled-luma matching (playback.py); first raw frame "
        "showing the cut frame kept; frames [first, first+N) decoded and re-encoded with libx264rgb -qp 0 and "
        "verified identical to the raw capture with framemd5 (bgr0)",
        "verified_bit_exact": True,
    }


def finalize(clip, work, info, scenario_state, page_records, actions, ff_cmd):
    raw = work / "raw.mkv"
    lines = [ln.split() for ln in (work / "frames.txt").read_text().splitlines() if ln.strip()]
    tb_num, tb_den = (int(x) for x in lines[0][1].split("/"))
    ts_us = [int(ln[2]) * 1_000_000 * tb_num // tb_den for ln in lines]
    expected_raw = info["phase_lock"]["frames_total"] if clip.source else clip.frames
    if len(ts_us) != expected_raw:
        raise RuntimeError(f"{clip.name}: encoder saw {len(ts_us)} frames, expected {expected_raw}")
    if any(b <= a for a, b in zip(ts_us, ts_us[1:])):
        raise RuntimeError(f"{clip.name}: non-increasing capture timestamps")

    if clip.source:
        info["trim"] = trim_to_cut(clip, work, ts_us, page_records, info["phase_lock"])
        start = info["trim"]["first_raw_frame"]
        ts_us = ts_us[start : start + clip.frames]
        raw = work / "trim.mkv"

    final = CORPUS / f"{clip.name}.mkv"
    tmp_final = work / "final.mkv"
    subprocess.run(
        [
            FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(raw),
            "-map", "0:v:0", "-c", "copy", "-bsf:v", f"setts=ts=N/({clip.fps}*TB)",
            "-metadata", f"title={clip.name}", "-metadata", "comment=capcodec lossless screen corpus (libx264rgb qp0, GBR)",
            str(tmp_final),
        ],
        check=True,
    )  # fmt: skip
    probe = json.loads(
        subprocess.run(
            [FFPROBE, "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
             "stream=codec_name,profile,pix_fmt,width,height,nb_read_packets,r_frame_rate", "-of", "json", str(tmp_final)],
            capture_output=True, text=True, check=True,
        ).stdout
    )["streams"][0]  # fmt: skip
    if int(probe["nb_read_packets"]) != clip.frames or (probe["width"], probe["height"]) != (clip.width, clip.height):
        raise RuntimeError(f"{clip.name}: remuxed file mismatch {probe}")
    shutil.move(str(tmp_final), final)

    timing = frame_timing(ts_us, clip.fps)
    progress = parse_progress(work / "progress.txt")
    ff_text = (work / "ffmpeg.log").read_text(errors="replace")
    frame_ms = [round(t / 1000.0, 3) for t in ts_us]
    video = {k: info.pop(k) for k in ("source_segment", "phase_lock", "trim", "video_stats_before", "video_stats_after") if k in info}
    cap_log = {
        "name": clip.name,
        "width": clip.width,
        "height": clip.height,
        "fps": clip.fps,
        "dsf": clip.dsf,
        "display": clip.display,
        "frames": clip.frames,
        "codec": "libx264rgb -preset ultrafast -qp 0 (H.264 High 4:4:4 Predictive, lossless, GBR planes)",
        "ffmpeg_command": ff_cmd,
        "ffmpeg_dup_frames": int(progress.get("dup_frames", 0)),
        "ffmpeg_drop_frames": int(progress.get("drop_frames", 0)),
        "ffmpeg_speed": progress.get("speed"),
        "ffmpeg_log_tail": ff_text.splitlines()[-12:],
        "timing": timing,
        "grab_latency_ms": info["calibration"]["grab_latency_ms"],
        "ffmpeg_startup_ms": info["calibration"]["startup_ms"],
        "first_frame_wallclock_ms": frame_ms[0],
        "scenario": {
            "start_offset_ms": round(scenario_state["start_wall"] * 1000.0 - frame_ms[0], 1) if scenario_state["start_wall"] else None,
            "end_offset_ms": round(scenario_state["end_wall"] * 1000.0 - frame_ms[0], 1) if scenario_state["end_wall"] else None,
            "truncated": scenario_state["truncated"],
            "error": scenario_state["error"],
        },
        "page": info,
        **video,
        "frame_wallclock_ms": frame_ms,
    }
    write_json(CORPUS / f"{clip.name}.capture.json", cap_log)
    (CORPUS / f"{clip.name}.capture.log").write_text(ff_text)
    shutil.copy(work / "pointer.jsonl", CORPUS / f"{clip.name}.pointer.jsonl")

    pointer = sideinfo.read_jsonl(CORPUS / f"{clip.name}.pointer.jsonl")
    events = list(page_records) + list(actions)
    last = None
    for p in pointer:
        pos = (p["x"], p["y"])
        if pos != last:
            events.append({"k": "pointer", "t": p["t"], "x": p["x"], "y": p["y"]})
            last = pos
    events.append({"k": "capture", "type": "first_frame", "t": frame_ms[0]})
    events.append({"k": "capture", "type": "last_frame", "t": frame_ms[-1]})
    events.sort(key=lambda e: e.get("tp", e["t"]))
    with open(CORPUS / f"{clip.name}.events.jsonl", "w") as f:
        for e in events:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")
    shutil.rmtree(work, ignore_errors=True)
    return postprocess(clip)


def text_regions_px(clip, css_rects):
    out = []
    for r in css_rects or []:
        x, y, w, h = (round(v * clip.dsf) for v in r)
        c = sideinfo.clip_rect([x, y, w, h], clip.width, clip.height)
        if c:
            out.append(c)
    return out


def previews(clip, stats_dirty):
    pdir = CORPUS / "previews"
    pdir.mkdir(exist_ok=True)
    for old in pdir.glob(f"{clip.name}_*.png"):
        old.unlink()
    n = clip.frames
    sheet_frames = [0, n // 3, (2 * n) // 3, n - 1]
    picks = sorted(set(sheet_frames) | {stats_dirty})
    sel = "+".join(f"eq(n\\,{i})" for i in picks)
    tmpl = pdir / f"{clip.name}_%02d.png"
    subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(CORPUS / f"{clip.name}.mkv"),
         "-vf", f"select='{sel}'", "-fps_mode", "passthrough", "-frames:v", str(len(picks)), str(tmpl)],
        check=True,
    )  # fmt: skip
    files = {}
    for k, i in enumerate(picks, start=1):
        src = pdir / f"{clip.name}_{k:02d}.png"
        dst = pdir / f"{clip.name}_f{i:05d}.png"
        src.replace(dst)
        files[i] = dst.name
    sheet = pdir / f"{clip.name}_sheet.png"
    inputs = []
    for i in sheet_frames:
        inputs += ["-i", str(pdir / files[i])]
    filt = (
        ";".join(f"[{k}:v]scale=960:-1[s{k}]" for k in range(4))
        + ";[s0][s1][s2][s3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]"
    )
    subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *inputs, "-filter_complex", filt, "-map", "[out]", str(sheet)], check=True)
    return [f"previews/{files[i]}" for i in picks] + [f"previews/{sheet.name}"]


def postprocess(clip):
    cap_log = json.load(open(CORPUS / f"{clip.name}.capture.json"))
    events = sideinfo.read_jsonl(CORPUS / f"{clip.name}.events.jsonl")
    pointer = sideinfo.read_jsonl(CORPUS / f"{clip.name}.pointer.jsonl")
    scroll = [e for e in events if e.get("k") == "scroll"]
    log(f"{clip.name}: computing side info")
    t = time.time()
    stats = sideinfo.compute(
        str(CORPUS / f"{clip.name}.mkv"),
        cap_log["frame_wallclock_ms"],
        clip.width,
        clip.height,
        clip.dsf,
        pointer if clip.draw_mouse else [],
        scroll,
        str(CORPUS / f"{clip.name}.sideinfo.jsonl"),
        ffmpeg=FFMPEG,
        grab_latency_ms=cap_log["grab_latency_ms"],
    )
    log(f"{clip.name}: side info done in {time.time() - t:.1f}s")
    max_dirty_frame = 0
    best = -1.0
    with open(CORPUS / f"{clip.name}.sideinfo.jsonl") as f:
        for line in f:
            rec = json.loads(line)
            if rec["frame"] == 0:
                continue
            area = sum(r[2] * r[3] for r in rec["dirty"])
            if area > best:
                best, max_dirty_frame = area, rec["frame"]
    prev_files = previews(clip, max_dirty_frame)
    timing = cap_log["timing"]
    entry = {
        "name": clip.name,
        "file": f"{clip.name}.mkv",
        "width": clip.width,
        "height": clip.height,
        "fps": clip.fps,
        "frames": clip.frames,
        "duration_s": round(clip.frames / clip.fps, 3),
        "sha256": sha256(CORPUS / f"{clip.name}.mkv"),
        "tags": clip.tags,
        "description": clip.description,
        "device_scale_factor": clip.dsf,
        "page": f"pages/{clip.page}",
        "text_regions": text_regions_px(clip, cap_log["page"].get("text_regions_css")),
        "sideinfo": f"{clip.name}.sideinfo.jsonl",
        "events": f"{clip.name}.events.jsonl",
        "pointer_samples": f"{clip.name}.pointer.jsonl",
        "capture_log": f"{clip.name}.capture.json",
        "previews": prev_files,
        "avg_dirty_fraction": stats["avg_dirty_fraction"],
        "identical_frames": stats["identical_frames"],
        "cursor_check": stats["cursor"],
        "capture": {
            "codec": "libx264rgb qp0 (lossless H.264 High 4:4:4 Predictive, GBR), ultrafast, keyint " + str(clip.fps * 5),
            "dropped_frames": timing["missed_slots"],
            "duplicated_frames": timing["catchup_grabs"],
            "ffmpeg_drop_frames": cap_log["ffmpeg_drop_frames"],
            "ffmpeg_dup_frames": cap_log["ffmpeg_dup_frames"],
            "late_grabs": timing["late_grabs"],
            "max_interval_ms": timing["max_interval_ms"],
            "interval_stdev_ms": timing["stdev_interval_ms"],
            "method": (
                f"ffmpeg x11grab -framerate {clip.fps} -draw_mouse {int(clip.draw_mouse)} -use_wallclock_as_timestamps 1 "
                f"on Xvfb {clip.display} ({clip.width}x{clip.height}x24), -fps_mode passthrough, encoder time base = "
                "demuxer (us); per-frame wallclock from -stats_enc_pre; remuxed with setts to CFR pts n/fps; Chrome kiosk, "
                f"--force-device-scale-factor={clip.dsf}"
            ),
        },
        "scroll_validation": stats["scroll"],
        "generator": {"script": "bench/corpus/generate.py", "args": ["--clip", clip.name]},
    }
    if clip.source:
        lock, trim = cap_log["phase_lock"], cap_log["trim"]
        entry["capture"]["method"] += (
            f"; ffmpeg relaunched until its grab grid sat {LOCK_TARGET_MS} +- {LOCK_TOLERANCE_MS} ms after Chrome's "
            "video presentation phase (requestVideoFrameCallback expectedDisplayTime), started before the cut and "
            "trimmed bit-exactly to the first frame showing it"
        )
        entry["capture"]["phase_lock"] = {
            "attempts": len(lock["attempts"]),
            "accepted_delta_ms": lock["attempts"][-1]["delta_ms"],
            "playback_restarts": lock["playback_restarts"],
        }
        entry["capture"]["trim"] = {k: trim[k] for k in ("raw_frames", "first_raw_frame", "rvfc_predicted_raw_frame", "verified_bit_exact")}
        if cap_log.get("capture_runs"):
            entry["capture"]["runs"] = cap_log["capture_runs"]
        entry["source_video"] = source_entry(clip, cap_log)
        entry["playback_check"] = playback_check(clip, cap_log, events)
        entry["playback"] = f"{clip.name}.playback.json"
    update_manifest(entry)
    return entry


def playback_clean(entry):
    pb, cap = entry["playback_check"], entry["capture"]
    return (
        pb["repeated_frames"] == 0
        and pb["skipped_source_frames"] == 0
        and pb["backward_steps"] == 0
        and pb["source_first"] == pb["source_first_expected"]
        and pb["source_last"] == pb["source_last_expected"]
        and cap["dropped_frames"] == 0
        and cap["duplicated_frames"] == 0
    )


def run_summary(entry):
    pb = entry["playback_check"]
    return {
        "repeated_frames": pb["repeated_frames"],
        "skipped_source_frames": pb["skipped_source_frames"],
        "irregular_steps": pb["irregular_steps"][:6],
        "identical_frames": entry["identical_frames"],
        "dropped_frames": entry["capture"]["dropped_frames"],
        "phase_lock_delta_ms": entry["capture"]["phase_lock"]["accepted_delta_ms"],
        "chrome_dropped": pb["chrome_video_quality"]["dropped_during_clip"],
    }


def record_runs(clip, entry, rejected):
    path = CORPUS / f"{clip.name}.capture.json"
    cap_log = json.load(open(path))
    cap_log["capture_runs"] = {
        "runs": len(rejected) + 1,
        "max_runs": SOURCE_CAPTURE_RUNS,
        "policy": "recapture while the playback check shows repeated/skipped source frames or dropped grabs",
        "rejected": rejected,
    }
    write_json(path, cap_log)
    entry["capture"]["runs"] = cap_log["capture_runs"]
    update_manifest(entry)
    return entry


def source_entry(clip, cap_log):
    src = clip.source
    seg = cap_log.get("source_segment", {})
    last = src.cut_frame + clip.frames - 1
    return {
        "title": src.title,
        "url": src.url,
        "homepage": src.homepage,
        "licence": src.licence,
        "licence_url": src.licence_url,
        "attribution": src.attribution,
        "zip_sha256": src.zip_sha256,
        "sha256": src.sha256,
        "cache_dir": str(CACHE),
        "segment": {
            "file": src.segment_name,
            "sha256": seg.get("sha256"),
            "start_s": src.segment_start_s,
            "frames": src.segment_frames,
            "source_first_frame_index": seg.get("source_first_frame_index"),
            "method": seg.get("method"),
        },
        "clip_source_range_s": [src.cut_s, round(src.segment_start_s + last / src.fps, 6)],
        "clip_segment_frames": [src.cut_frame, last],
        "transcoded": False,
        "playback": "Chrome <video> (software H.264 decode of the original stream), muted, loop, object-fit: cover, "
        "1:1 pixels at 1920x1080",
    }


def playback_check(clip, cap_log, events):
    src = clip.source
    log(f"{clip.name}: matching captured frames to source frames")
    seg = source_features(src)
    cap = playback.features(playback.luma_frames(FFMPEG, CORPUS / f"{clip.name}.mkv"))
    if len(cap) != clip.frames:
        raise RuntimeError(f"{clip.name}: decoded {len(cap)} frames for the playback check")
    js, chosen, other = playback.match(cap, seg, src.cut_frame)
    summary = playback.summarize(js, chosen, other, first_expected=src.cut_frame)
    fm = cap_log["frame_wallclock_ms"]
    summary["chrome_presentation"] = playback.video_frame_stats(events, fm[0], fm[-1], clip.fps)
    stats = [e for e in events if e.get("k") == "action" and e.get("type") == "video_stats"]
    after = cap_log.get("video_stats_after") or {}
    summary["chrome_video_quality"] = {
        "samples_during_clip": len(stats),
        "dropped_during_clip": stats[-1]["dropped_video_frames"] - stats[0]["dropped_video_frames"] if len(stats) > 1 else None,
        "decoded_during_clip": stats[-1]["total_video_frames"] - stats[0]["total_video_frames"] if len(stats) > 1 else None,
        "dropped_total_at_end": after.get("dropped_video_frames"),
        "decoded_total_at_end": after.get("total_video_frames"),
    }
    captured = playback.dirty_fractions(CORPUS / f"{clip.name}.sideinfo.jsonl", clip.width, clip.height)
    summary["dirty_fraction_per_frame"] = playback.dirty_distribution(captured)
    summary["dirty_vs_source"] = playback.dirty_vs_source(captured, source_dirty(src), js)
    summary["method"] = (
        "captured and source frames area-downscaled to 480x270 luma, high-passed and normalised (playback.py); each "
        "captured frame matched to a source frame by 1 - normalised cross-correlation along a monotonic Viterbi path "
        f"(offset band +-{playback.BAND}, {playback.OFFSET_PENALTY} per offset change); repeated_frames and "
        "skipped_source_frames count source steps of 0 and >1 between consecutive captured frames"
    )
    write_json(
        CORPUS / f"{clip.name}.playback.json",
        {**summary, "source_frame_per_frame": js, "match_distance_per_frame": [round(x, 4) for x in chosen]},
    )
    return summary


def load_manifest():
    if MANIFEST.exists():
        return json.load(open(MANIFEST))
    return {"version": 1, "clips": []}


def update_manifest(entry=None, **top):
    m = load_manifest()
    m["version"] = 1
    m["corpus_dir"] = str(CORPUS)
    m.update(top)
    clips = {c["name"]: c for c in m.get("clips", [])}
    if entry is not None:
        clips[entry["name"]] = entry
    order = [c.name for c in CLIPS]
    m["clips"] = [clips[n] for n in order if n in clips] + [c for n, c in clips.items() if n not in order]
    write_json(MANIFEST, m)


def verify_lossless(xvfb):
    """Feed one x11grab input to rawvideo and to libx264rgb qp0 and compare decoded frame hashes."""
    results = []
    for clip in (CLIP_BY_NAME["dashboard"], CLIP_BY_NAME["code_4k"]):
        from playwright.sync_api import sync_playwright

        work = CORPUS / ".work" / f"lossless_{clip.name}"
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True)
        xvfb.ensure(clip.display, clip.width, clip.height)
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                str(work / "profile"),
                channel=CHROME_CHANNEL,
                headless=False,
                no_viewport=True,
                args=chrome_args(clip),
                ignore_default_args=["--enable-automation"],
                env={**os.environ, "DISPLAY": clip.display},
            )
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto((PAGES / clip.page.split("?")[0]).as_uri())
                fit_window(clip, page)
                page.wait_for_function("window.capReady === true", timeout=15000)
                if "capStart" in clip.prepare_js:
                    page.evaluate(clip.prepare_js)
                else:
                    page.evaluate("capEditor.scroller.scrollTop = 0; setInterval(() => { capEditor.scroller.scrollTop += 19; }, 120)")
                page.wait_for_timeout(1000)
                n = 3 * clip.fps
                cmd = [
                    FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                    "-f", "x11grab", "-framerate", str(clip.fps), "-video_size", f"{clip.width}x{clip.height}",
                    "-draw_mouse", "1", "-i", clip.display, "-frames:v", str(n),
                    "-map", "0:v", "-c:v", "rawvideo", "-f", "nut", str(work / "ref.nut"),
                    "-map", "0:v", "-frames:v", str(n), "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0",
                    "-threads", str(clip.threads), str(work / "x264.mkv"),
                ]  # fmt: skip
                proc = subprocess.Popen(cmd)
                inp = scenarios.Input(clip.display, lambda *a, **k: None, random.Random(1))
                inp.warp(200, 200)
                end = time.time() + 3.5
                while proc.poll() is None and time.time() < end:
                    inp.move(random.uniform(100, clip.width - 100), random.uniform(100, clip.height - 100), dur=0.4)
                proc.wait(timeout=60)
            finally:
                ctx.close()
        hashes = {}
        for name in ("ref.nut", "x264.mkv"):
            out = subprocess.run(
                [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(work / name), "-map", "0:v",
                 "-pix_fmt", "bgr0", "-f", "framemd5", "-"],
                capture_output=True, text=True, check=True,
            ).stdout  # fmt: skip
            hashes[name] = [ln.split(",")[-1].strip() for ln in out.splitlines() if ln and not ln.startswith("#")]
        a, b = hashes["ref.nut"], hashes["x264.mkv"]
        same = sum(x == y for x, y in zip(a, b))
        distinct = len(set(a))
        res = {
            "resolution": f"{clip.width}x{clip.height}",
            "fps": clip.fps,
            "frames_compared": min(len(a), len(b)),
            "frames_identical": same,
            "distinct_frames": distinct,
            "lossless": len(a) == len(b) and same == len(a) and len(a) > 0,
        }
        log(f"lossless check {res}")
        results.append(res)
        shutil.rmtree(work)
    summary = {
        "method": "single x11grab input -> (a) rawvideo NUT and (b) libx264rgb -preset ultrafast -qp 0 in one ffmpeg run; "
        "framemd5 of both decoded to bgr0 compared frame by frame",
        "results": results,
        "lossless": all(r["lossless"] for r in results),
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    write_json(CORPUS / "lossless_check.json", summary)
    update_manifest(lossless_check=summary)
    return summary


def outputs_exist(clip):
    return all((CORPUS / f"{clip.name}{ext}").exists() for ext in (".mkv", ".sideinfo.jsonl", ".events.jsonl", ".capture.json"))


def main():
    ap = argparse.ArgumentParser(description="Generate the screen-recording benchmark corpus.")
    ap.add_argument("--clip", action="append", default=[], help="clip name (repeatable)")
    ap.add_argument("--all", action="store_true", help="generate every clip")
    ap.add_argument("--missing", action="store_true", help="with --all: skip clips whose outputs already exist")
    ap.add_argument("--sideinfo-only", action="store_true", help="recompute side info/previews/manifest from existing captures")
    ap.add_argument("--verify-lossless", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for c in CLIPS:
            print(f"{c.name:16s} {c.width}x{c.height}@{c.fps} {c.duration}s dsf={c.dsf} {c.page}")
        return 0
    names = [c.name for c in CLIPS] if args.all else args.clip
    unknown = [n for n in names if n not in CLIP_BY_NAME]
    if unknown:
        ap.error(f"unknown clip(s): {', '.join(unknown)}")
    if not names and not args.verify_lossless:
        ap.error("nothing to do (use --clip NAME, --all, --verify-lossless or --list)")

    CORPUS.mkdir(parents=True, exist_ok=True)
    xvfb = XvfbManager()
    failures = []
    try:
        if args.verify_lossless:
            s = verify_lossless(xvfb)
            if not s["lossless"]:
                failures.append("lossless_check")
        for n in names:
            clip = CLIP_BY_NAME[n]
            if args.missing and outputs_exist(clip):
                log(f"{n}: outputs exist, skipping")
                continue
            log(f"{n}: start ({clip.width}x{clip.height}@{clip.fps}, {clip.duration}s, {clip.display})")
            try:
                if args.sideinfo_only:
                    entry = postprocess(clip)
                else:
                    entry = capture(clip, xvfb)
                    rejected = []
                    while clip.source and not playback_clean(entry) and len(rejected) + 1 < SOURCE_CAPTURE_RUNS:
                        rejected.append(run_summary(entry))
                        log(f"{n}: playback check not clean {rejected[-1]}, recapturing")
                        entry = capture(clip, xvfb)
                    if clip.source:
                        entry = record_runs(clip, entry, rejected)
                cap_log = json.load(open(CORPUS / f"{n}.capture.json"))
                if cap_log["scenario"]["error"]:
                    failures.append(n)
                elif clip.source and not playback_clean(entry):
                    log(f"{n}: playback check still not clean after {SOURCE_CAPTURE_RUNS} runs")
                    failures.append(n)
                sv = entry["scroll_validation"]
                log(
                    f"{n}: done frames={entry['frames']} dirty={entry['avg_dirty_fraction']:.4f} "
                    f"dropped={entry['capture']['dropped_frames']} late={entry['capture']['late_grabs']} "
                    f"scroll={sv['validated_frames']}/{sv['frames_with_scroll'] - sv.get('unverifiable_frames', 0)}"
                    f"(+{sv.get('unverifiable_frames', 0)} unverifiable) lat={sv['latency_ms']}ms "
                    f"cursor={entry['cursor_check']['fraction']} truncated={cap_log['scenario']['truncated']}"
                )
                if "playback_check" in entry:
                    pb = entry["playback_check"]
                    log(
                        f"{n}: source frames {pb['source_first']}..{pb['source_last']} repeated={pb['repeated_frames']} "
                        f"skipped={pb['skipped_source_frames']} identical={entry['identical_frames']} "
                        f"dirty min={pb['dirty_fraction_per_frame']['min']} >=0.99: "
                        f"{pb['dirty_fraction_per_frame']['frames_ge_0_99']}/{pb['dirty_fraction_per_frame']['frames_considered']} "
                        f"chrome dropped={pb['chrome_video_quality']['dropped_during_clip']}"
                    )
            except Exception:
                log(f"{n}: FAILED\n{traceback.format_exc()}")
                failures.append(n)
    finally:
        xvfb.stop_all()
    if failures:
        log(f"failures: {failures}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
