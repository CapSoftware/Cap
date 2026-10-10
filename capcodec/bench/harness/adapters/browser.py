import hashlib
import os
import time
from pathlib import Path

from ..common import RunResult
from ..corpus import Source
from .base import Adapter, EncodeOutput, Point

PAGE_DIR = Path(__file__).resolve().parents[1] / "browser"
CHROME_ARGS = ["--autoplay-policy=no-user-gesture-required", "--disable-gpu", "--no-first-run",
               "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
               "--disable-backgrounding-occluded-windows"]

_chrome_version: str | None = None


def chrome_version() -> str:
    global _chrome_version
    if _chrome_version is None:
        try:
            import subprocess
            exe = os.environ.get("CAPCODEC_CHROME", "google-chrome")
            _chrome_version = subprocess.run([exe, "--version"], capture_output=True, text=True).stdout.strip()
        except OSError:
            _chrome_version = "missing"
    return _chrome_version


def page_hash() -> str:
    h = hashlib.sha256()
    for f in sorted(PAGE_DIR.glob("*")):
        if f.suffix in (".html", ".js"):
            h.update(f.read_bytes())
    return h.hexdigest()[:16]


def descendants_cpu() -> float:
    import psutil
    total = 0.0
    try:
        for p in psutil.Process().children(recursive=True):
            try:
                ct = p.cpu_times()
                total += ct.user + ct.system
            except psutil.Error:
                pass
    except psutil.Error:
        pass
    return total


def run_in_chrome(job: dict, src: Source, workdir: Path, timeout_s: float) -> tuple[dict, float, float]:
    from playwright.sync_api import sync_playwright

    from ..browser.server import JobState, server
    srv = server()
    state = JobState(src.path, src.frame_bytes, src.frames, workdir)
    jid = srv.add(state)
    job = {**job, "id": jid}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True, args=CHROME_ARGS)
            try:
                page = browser.new_page()
                page.goto(f"{srv.origin}/encode.html")
                cpu0 = descendants_cpu()
                t0 = time.perf_counter()
                page.evaluate("job => { window.runJob(job); }", job)
                page.wait_for_function("window.__status.state === 'done' || window.__status.state === 'error'",
                                       timeout=timeout_s * 1000, polling=200)
                wall = time.perf_counter() - t0
                cpu = descendants_cpu() - cpu0
                status = page.evaluate("window.__status")
            finally:
                browser.close()
    finally:
        srv.remove(jid)
    return status, wall, cpu


class BrowserAdapter(Adapter):
    family = "browser"
    weight = 2
    speed_weight = 0
    production = True

    def __init__(self, name: str, mode: str, description: str, config_fn, ladder_fn, ext: str = "mp4",
                 key_interval_s: float | None = 2.0, timeslice_ms: int | None = None):
        self.name = name
        self.mode = mode
        self.description = description
        self.config_fn = config_fn
        self.ladder_fn = ladder_fn
        self.ext = ext
        self.key_interval_s = key_interval_s
        self.timeslice_ms = timeslice_ms
        self.container = "annexb" if mode == "webcodecs" else ext

    def available(self) -> tuple[bool, str]:
        try:
            import playwright  # noqa: F401
        except ImportError:
            return False, "playwright not installed"
        if chrome_version() == "missing":
            return False, "Google Chrome not found"
        return True, ""

    def identity(self) -> dict:
        return {"adapter": self.name, "mode": self.mode, "chrome": chrome_version(), "page": page_hash(),
                "key_interval_s": self.key_interval_s, "ext": self.ext, "timeslice": self.timeslice_ms,
                "config": self.config_fn.__name__}

    def points(self, tier: str, src: Source, anchor_kbps: float | None = None) -> list[Point]:
        return self.ladder_fn(src, anchor_kbps)

    def encode(self, src: Source, point: Point, workdir: Path, speed: bool = False) -> EncodeOutput:
        config = self.config_fn(src, point.params)
        fps = src.fps
        job = {"mode": self.mode, "config": config, "width": src.width, "height": src.height,
               "frames": src.frames, "fpsNum": fps.numerator, "fpsDen": fps.denominator, "ext": self.ext,
               "keyInterval": int(round(self.key_interval_s * src.fps_float)) if self.key_interval_s else 0,
               "timeslice": self.timeslice_ms}
        timeout = 120 + 3 * src.duration_s + src.frames * 0.2
        status, wall, cpu = run_in_chrome(job, src, workdir, timeout)
        name = "out.264" if self.mode == "webcodecs" else f"out.{self.ext}"
        out = workdir / name
        err = None
        if status.get("state") != "done" or not out.exists():
            err = status.get("error") or f"browser state {status.get('state')}"
        result = status.get("result") or {}
        rr = RunResult(0 if err is None else 1, wall, cpu, 0.0)
        return EncodeOutput(file=out, container=self.container, run=rr, error=err,
                            extra={"browser": result, "config": config, "chrome": chrome_version(),
                                   "note": "headless Google Chrome on Linux: software H.264 (OpenH264)"})


def browser_adapters() -> list[Adapter]:
    try:
        from .cap_baselines import cap_browser_adapters
        return cap_browser_adapters()
    except ImportError:
        return []
