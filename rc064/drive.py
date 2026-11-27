"""Drives the 0.6.3 and main builds of the GPUI app through the same user
flows and writes results.json plus screenshots.

Usage: drive.py <apps-root> <harness-root> <out> [flows]
apps-root holds base/ and head/ (each the unpacked app tarball).
"""

import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil

OS = platform.system()
APPS = Path(sys.argv[1]).resolve()
HARNESS = Path(sys.argv[2]).resolve()
OUT = Path(sys.argv[3]).resolve()
FLOWS = (sys.argv[4] if len(sys.argv) > 4 else "all").split(",")
SHOTS = OUT / "shots"
WORK = Path(tempfile.mkdtemp(prefix="rc064-"))
SIDES = [s for s in os.environ["GATE_SIDES"].split(",")] if os.environ.get("GATE_SIDES") else [s for s in ("v062", "base", "head") if (APPS / s / "bin").exists()]
RESULTS = {"os": OS, "flows": {}}
EXE = ".exe" if OS == "Windows" else ""
API_KEY = None
OWNER = None

SHOTS.mkdir(parents=True, exist_ok=True)


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def save():
    (OUT / "results.json").write_text(json.dumps(RESULTS, indent=2, default=str))


def record(flow, side, data):
    RESULTS["flows"].setdefault(flow, {}).setdefault(side, []).append(data)
    save()


def app_bin(side):
    return APPS / side / "bin" / f"cap-gpui{EXE}"


def harness_bin():
    return HARNESS / "deps" / f"harness{EXE}"


def lib_env(env, root):
    if OS == "Linux":
        env["LD_LIBRARY_PATH"] = str(root / "lib")
    return env


# ---------------------------------------------------------------- sandboxes


class Sandbox:
    def __init__(self, name, server=None, theme="light", general=None, store=None):
        self.root = WORK / name
        if self.root.exists():
            shutil.rmtree(self.root)
        (self.root / "recordings").mkdir(parents=True)
        (self.root / "logs").mkdir()
        g = {
            "serverUrl": server or "http://127.0.0.1:9",
            "enableNotifications": False,
            "hasCompletedOnboarding": True,
            "hasCompletedStartup": True,
            "recordingCountdown": 0,
            "enableTelemetry": False,
            "theme": theme,
        }
        g.update(general or {})
        doc = {
            "general_settings": g,
            "recording_start_safety": {"confirmBeforeRecordingWithoutMicrophone": False},
        }
        if server:
            doc["auth"] = {
                "secret": {"api_key": API_KEY},
                "user_id": OWNER,
                "plan": {"upgraded": True, "manual": True},
                "organizations": [],
            }
        doc.update(store or {})
        (self.root / "store").write_text(json.dumps(doc))
        self.logs = {}

    def projects(self):
        return sorted(p for p in (self.root / "recordings").glob("*.cap") if p.is_dir())

    def launch(self, side, name, env=None, tray=False):
        e = dict(os.environ)
        e.update(
            {
                "CAP_GPUI_APP_DATA_DIR": str(self.root),
                "CAP_GPUI_RECORDINGS_DIR": str(self.root / "recordings"),
                "CAP_GPUI_LOG_DIR": str(self.root / "logs"),
                "CAP_GPUI_NO_MENUS": "1",
                "RUST_LOG": "cap_gpui=info,cap_recording=info,cap_editor=info",
                "NO_COLOR": "1",
            }
        )
        if not tray:
            e["CAP_GPUI_NO_TRAY"] = "1"
        lib_env(e, APPS / side)
        e.update(env or {})
        path = self.root / f"{side}-{name}.log"
        handle = open(path, "wb")
        proc = subprocess.Popen([str(app_bin(side))], env=e, stdout=handle, stderr=subprocess.STDOUT)
        proc.log_path = path
        proc.started = time.monotonic()
        return proc


def text(proc):
    try:
        raw = proc.log_path.read_text(errors="replace")
    except OSError:
        return ""
    out = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "\x1b":
            i += 1
            while i < len(raw) and not raw[i].isalpha():
                i += 1
        else:
            out.append(c)
        i += 1
    return "".join(out)


def wait_log(proc, needle, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle in text(proc):
            return time.monotonic()
        if proc.poll() is not None and needle not in text(proc):
            return None
        time.sleep(0.1)
    return None


def kill(proc):
    if proc is None:
        return
    try:
        p = psutil.Process(proc.pid)
        for child in p.children(recursive=True):
            child.kill()
    except psutil.Error:
        pass
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass


def tail(proc, n=40, grep=None):
    lines = text(proc).splitlines()
    if grep:
        lines = [line for line in lines if any(g in line for g in grep)]
    return lines[-n:]


# ---------------------------------------------------------------- windows


def visible_windows(pid):
    """(x, y, w, h, title) of visible on-screen windows owned by pid."""
    if OS == "Darwin":
        try:
            out = subprocess.run([str(WORK / "winlist"), str(pid)], capture_output=True, text=True, timeout=5).stdout
        except subprocess.TimeoutExpired:
            return []
        result = []
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 5:
                result.append((float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]), parts[4]))
        return result
    if OS == "Windows":
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def cb(hwnd, _):
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid and user32.IsWindowVisible(hwnd):
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                buf = ctypes.create_unicode_buffer(256)
                user32.GetWindowTextW(hwnd, buf, 256)
                w, h = rect.right - rect.left, rect.bottom - rect.top
                if w > 1 and h > 1:
                    found.append((rect.left, rect.top, w, h, buf.value))
            return True

        user32.EnumWindows(cb, 0)
        return found
    out = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(pid)], capture_output=True, text=True).stdout
    result = []
    for wid in out.split():
        geo = subprocess.run(["xdotool", "getwindowgeometry", "--shell", wid], capture_output=True, text=True).stdout
        vals = dict(line.split("=", 1) for line in geo.splitlines() if "=" in line)
        name = subprocess.run(["xdotool", "getwindowname", wid], capture_output=True, text=True).stdout.strip()
        try:
            w, h = int(vals.get("WIDTH", 0)), int(vals.get("HEIGHT", 0))
        except ValueError:
            continue
        if w > 1 and h > 1:
            result.append((int(vals.get("X", 0)), int(vals.get("Y", 0)), w, h, name))
    return result


def wait_window(proc, timeout=60, min_size=200):
    deadline = proc.started + timeout
    while time.monotonic() < deadline:
        wins = [w for w in visible_windows(proc.pid) if w[2] >= min_size and w[3] >= 100]
        if wins:
            return time.monotonic() - proc.started, wins
        if proc.poll() is not None:
            return None, []
        time.sleep(0.02)
    return None, []


def screenshot(name):
    path = SHOTS / f"{name}.png"
    try:
        if OS == "Darwin":
            subprocess.run(["screencapture", "-x", str(path)], timeout=20)
        elif OS == "Windows":
            from PIL import ImageGrab

            ImageGrab.grab(all_screens=True).save(path)
        else:
            subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1920x1080", "-i", os.environ["DISPLAY"], "-frames:v", "1", str(path)],
                timeout=20,
            )
        if path.exists() and OS != "Windows":
            subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-vf", "scale='min(1600,iw)':-2", str(path.with_suffix(".tmp.png"))], timeout=20
            )
            if path.with_suffix(".tmp.png").exists():
                path.with_suffix(".tmp.png").replace(path)
    except Exception as error:  # noqa: BLE001
        log("screenshot failed", name, error)
    return f"shots/{name}.png" if path.exists() else None


# ---------------------------------------------------------------- media


def ffprobe(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,start_time,duration,nb_frames,width,height,sample_rate,channels", "-of", "json", str(path)],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
        data = json.loads(out or "{}")
    except Exception as error:  # noqa: BLE001
        return {"error": str(error)}
    result = {"duration": float(data.get("format", {}).get("duration", 0) or 0), "streams": []}
    video_start = audio_start = None
    for s in data.get("streams", []):
        result["streams"].append(s)
        if s.get("codec_type") == "video" and video_start is None:
            video_start = float(s.get("start_time", 0) or 0)
        if s.get("codec_type") == "audio" and audio_start is None:
            audio_start = float(s.get("start_time", 0) or 0)
    if video_start is not None and audio_start is not None:
        result["av_start_offset_ms"] = round((audio_start - video_start) * 1000, 2)
    result["decodes"] = decodes(path)
    return result


def decodes(path):
    try:
        run = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"], capture_output=True, text=True, timeout=300)
        return {"ok": run.returncode == 0, "errors": run.stderr.strip().splitlines()[:5]}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "errors": [str(error)]}


def file_list(root):
    out = {}
    if not root.exists():
        return out
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(root))] = p.stat().st_size
    return out


def concat(parts, dest):
    with open(dest, "wb") as f:
        for p in parts:
            f.write(Path(p).read_bytes())
    return dest


def local_media(project):
    """Every playable stream in a project, probed."""
    found = {}
    content = project / "content"
    for mp4 in sorted(content.rglob("*.mp4")):
        if mp4.name.startswith("init"):
            continue
        found[str(mp4.relative_to(project))] = ffprobe(mp4)
    for init in sorted(content.rglob("init.mp4")):
        segs = sorted(init.parent.glob("segment_*.m4s"))
        if segs:
            joined = concat([init] + segs, WORK / f"joined-{abs(hash(str(init)))}.mp4")
            found[str(init.parent.relative_to(project)) + "/(joined)"] = ffprobe(joined)
    for m4a in sorted(content.rglob("*.ogg")) + sorted(content.rglob("*.m4a")):
        found[str(m4a.relative_to(project))] = ffprobe(m4a)
    return found


def meta_status(project):
    try:
        meta = json.loads((project / "recording-meta.json").read_text())
    except Exception:  # noqa: BLE001
        return None
    status = meta.get("status")
    if status is None and isinstance(meta.get("studio"), dict):
        status = meta["studio"].get("status")
    return status


# ---------------------------------------------------------------- sampling


class Sampler:
    def __init__(self, pid):
        self.pid = pid
        self.samples = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            proc = psutil.Process(self.pid)
            proc.cpu_percent(None)
        except psutil.Error:
            return
        while not self.stop.wait(1.0):
            try:
                procs = [proc] + proc.children(recursive=True)
                cpu = sum(p.cpu_percent(None) for p in procs)
                rss = sum(p.memory_info().rss for p in procs)
                self.samples.append((cpu, rss))
            except psutil.Error:
                break

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(timeout=5)

    def summary(self):
        s = self.samples[1:] or self.samples
        if not s:
            return None
        cpus = sorted(c for c, _ in s)
        mem = [r for _, r in s]
        return {
            "samples": len(s),
            "cpu_mean_pct": round(sum(cpus) / len(cpus), 1),
            "cpu_p95_pct": round(cpus[int(len(cpus) * 0.95) - 1 if len(cpus) > 1 else 0], 1),
            "rss_mean_mb": round(sum(mem) / len(mem) / 1048576, 1),
            "rss_peak_mb": round(max(mem) / 1048576, 1),
            "rss_end_mb": round(mem[-1] / 1048576, 1),
        }


# ---------------------------------------------------------------- mock server


class Mock:
    def __init__(self, name):
        global API_KEY, OWNER
        self.dir = WORK / f"mock-{name}"
        self.dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["RC064_MOCK_DIR"] = str(self.dir)
        lib_env(env, HARNESS)
        self.log = open(self.dir / "mock.log", "wb")
        self.proc = subprocess.Popen(
            [str(harness_bin()), "--ignored", "--exact", "upload::real_app_tests::rc064_mock_server", "--nocapture", "--test-threads=1"],
            env=env,
            stdout=self.log,
            stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + 60
        while not (self.dir / "server.json").exists():
            if time.monotonic() > deadline or self.proc.poll() is not None:
                raise RuntimeError("mock server did not start: " + (self.dir / "mock.log").read_text(errors="replace")[-2000:])
            time.sleep(0.1)
        info = json.loads((self.dir / "server.json").read_text())
        self.url = info["url"]
        API_KEY, OWNER = info["api_key"], info["owner"]

    def finish(self):
        (self.dir / "stop").write_text("1")
        deadline = time.monotonic() + 60
        while not (self.dir / "done").exists() and time.monotonic() < deadline:
            time.sleep(0.2)
        kill(self.proc)
        try:
            return json.loads((self.dir / "summary.json").read_text())
        except Exception:  # noqa: BLE001
            return {}

    def uploaded_media(self):
        objects = self.dir / "objects"
        found = {}
        if not objects.exists():
            return found
        for mp4 in sorted(objects.rglob("*.mp4")):
            if mp4.name.startswith("init"):
                continue
            found[str(mp4.relative_to(objects))] = ffprobe(mp4)
        for init in sorted(objects.rglob("init.mp4")):
            segs = sorted(init.parent.glob("segment_*.m4s"))
            if segs:
                joined = concat([init] + segs, WORK / f"up-{abs(hash(str(init)))}.mp4")
                found[str(init.parent.relative_to(objects)) + "/(joined)"] = ffprobe(joined)
        return found


# ---------------------------------------------------------------- per-OS record env


def record_env(mic=True):
    env = {}
    if OS == "Linux":
        env.update({"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": "xmessage"})
    if not mic or OS == "Windows":
        env["CAP_GPUI_AUTO_NO_MIC"] = "1"
    return env


# ---------------------------------------------------------------- flows


def flow_startup():
    for rnd in range(5):
        for side in (SIDES if rnd % 2 == 0 else SIDES[::-1]):
            theme = "dark" if rnd == 1 else "light"
            sb = Sandbox(f"start-{side}-{rnd}", theme=theme)
            proc = sb.launch(side, "start")
            elapsed, wins = wait_window(proc, 90)
            entry = {"round": rnd, "first_window_s": round(elapsed, 3) if elapsed else None, "windows": wins}
            if elapsed is not None:
                time.sleep(3)
                if rnd < 2:
                    entry["shot"] = screenshot(f"main-{theme}-{side}")
                with Sampler(proc.pid) as s:
                    time.sleep(6)
                entry["idle"] = s.summary()
            entry["alive"] = proc.poll() is None
            entry["log"] = tail(proc, 15)
            kill(proc)
            record("startup", side, entry)
            log("startup", side, rnd, entry["first_window_s"])


def suspend(pid):
    if OS == "Windows":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x0800, False, pid)
        ctypes.windll.ntdll.NtSuspendProcess(handle)
    else:
        os.kill(pid, signal.SIGSTOP)


def resume(pid):
    if OS == "Windows":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x0800, False, pid)
        ctypes.windll.ntdll.NtResumeProcess(handle)
    else:
        os.kill(pid, signal.SIGCONT)


def flow_instances():
    for side in SIDES:
        sb = Sandbox(f"second-{side}")
        a = sb.launch(side, "first")
        elapsed, _ = wait_window(a, 90)
        time.sleep(2)
        b = sb.launch(side, "second")
        t0 = time.monotonic()
        try:
            code = b.wait(timeout=30)
        except subprocess.TimeoutExpired:
            code = "still running after 30s"
        entry = {
            "first_window_s": elapsed,
            "second_exit": code,
            "second_exit_s": round(time.monotonic() - t0, 2),
            "first_alive": a.poll() is None,
            "first_windows": visible_windows(a.pid),
            "second_log": tail(b, 12),
            "first_log": tail(a, 8, grep=["reopen", "forward", "already running", "Requested"]),
            "shot": screenshot(f"second-instance-{side}"),
        }
        kill(b)
        kill(a)
        record("second_instance", side, entry)

        sb = Sandbox(f"hung-{side}")
        a = sb.launch(side, "first")
        wait_window(a, 90)
        time.sleep(2)
        suspend(a.pid)
        b = sb.launch(side, "second")
        t0 = time.monotonic()
        try:
            code = b.wait(timeout=25)
        except subprocess.TimeoutExpired:
            code = None
        entry = {
            "second_exit": code if code is not None else "running",
            "second_s": round(time.monotonic() - t0, 2),
            "second_windows": visible_windows(b.pid) if code is None else [],
            "first_alive": a.poll() is None,
            "second_log": tail(b, 15),
            "shot": screenshot(f"hung-instance-{side}"),
        }
        try:
            resume(a.pid)
        except Exception:  # noqa: BLE001
            pass
        kill(b)
        kill(a)
        record("hung_instance", side, entry)
        log("instances", side, entry["second_exit"])


def flow_instant():
    for side in SIDES:
        mock = Mock(f"instant-{side}")
        sb = Sandbox(f"instant-{side}", server=mock.url)
        env = record_env()
        env["CAP_GPUI_AUTO_RECORD"] = "instant:60"
        proc = sb.launch(side, "record", env)
        entry = {}
        t_start = wait_log(proc, "auto-record start requested", 90)
        entry["started"] = t_start is not None
        if t_start:
            time.sleep(8)
            entry["shot_recording"] = screenshot(f"instant-recording-{side}")
            with Sampler(proc.pid) as s:
                t_stop = wait_log(proc, "auto-record stop requested", 120)
            entry["recording_resources"] = s.summary()
            entry["stop_seen"] = t_stop is not None
            deadline = time.monotonic() + 300
            verified_at = None
            while time.monotonic() < deadline:
                projects = sb.projects()
                state = None
                if projects:
                    try:
                        state = json.loads((projects[0] / "instant-upload.json").read_text())
                    except Exception:  # noqa: BLE001
                        state = None
                if state and state.get("phase") == "Verified":
                    verified_at = time.monotonic()
                    break
                time.sleep(0.25)
            entry["verified"] = verified_at is not None
            if verified_at and t_stop:
                entry["stop_to_verified_s"] = round(verified_at - t_stop, 2)
            time.sleep(4)
            entry["shot_after"] = screenshot(f"instant-after-{side}")
            entry["main_window"] = tail(proc, 4, grep=["auto-record main window"])
        entry["log_errors"] = tail(proc, 15, grep=["ERROR", "panicked"])
        kill(proc)
        summary = mock.finish()
        entry["server"] = {
            "created": summary.get("created"),
            "confirmed": len(summary.get("confirmations") or []),
            "deleted": summary.get("deleted"),
            "objects": len(summary.get("objects") or []),
        }
        entry["uploaded_media"] = mock.uploaded_media()
        projects = sb.projects()
        if projects:
            entry["local_media"] = local_media(projects[0])
        record("instant", side, entry)
        log("instant", side, entry.get("verified"), entry.get("stop_to_verified_s"))


def studio_record(side, name, theme="light", secs=30, behaviour="showOverlay", shot_prefix=None):
    sb = Sandbox(name, theme=theme, general={"postStudioRecordingBehaviour": behaviour})
    env = record_env()
    env["CAP_GPUI_AUTO_RECORD"] = f"studio:{secs}"
    env["CAP_GPUI_AUTO_PAUSE"] = "1"
    proc = sb.launch(side, "record", env)
    entry = {"wall_s": secs, "paused_s": secs - 2 * ((secs + 2) // 3)}
    t_start = wait_log(proc, "auto-record start requested", 90)
    entry["started"] = t_start is not None
    if t_start:
        time.sleep(max(2, secs // 6))
        if shot_prefix:
            entry["shot_recording"] = screenshot(f"{shot_prefix}-recording-{side}")
        with Sampler(proc.pid) as s:
            t_stop = wait_log(proc, "auto-record stop requested", secs + 60)
        entry["recording_resources"] = s.summary()
        done = wait_log(proc, "auto-record main window after the recording", 120)
        entry["finished"] = done is not None
        if t_stop and done:
            entry["stop_to_idle_s"] = round(done - t_stop, 2)
        time.sleep(3)
        if shot_prefix:
            entry["shot_after"] = screenshot(f"{shot_prefix}-after-{side}")
            entry["windows_after"] = visible_windows(proc.pid)
    entry["log_errors"] = tail(proc, 15, grep=["ERROR", "panicked"])
    kill(proc)
    projects = sb.projects()
    entry["project"] = str(projects[0]) if projects else None
    if projects:
        entry["status"] = meta_status(projects[0])
        entry["local_media"] = local_media(projects[0])
    return sb, entry


def editor_export(side, sb, project, kind, theme_shot=None, extra=None):
    out_dir = WORK / f"exports-{side}"
    out_dir.mkdir(exist_ok=True)
    target = {"mp4": out_dir / f"{kind}.mp4", "gif": out_dir / f"{kind}.gif", "tracks": out_dir / "tracks"}[kind if kind in ("gif", "tracks") else "mp4"]
    if kind == "tracks":
        target.mkdir(exist_ok=True)
    env = {"CAP_GPUI_AUTO_EDITOR": str(project), "CAP_GPUI_AUTO_EXPORT": str(target)}
    if kind == "mp4":
        env["CAP_GPUI_AUTO_PLAYBACK"] = "5"
    if kind == "tracks":
        env["CAP_GPUI_AUTO_EXPORT_TRACKS"] = "screen,microphone"
    env.update(extra or {})
    proc = sb.launch(side, f"export-{kind}", env)
    entry = {"kind": kind}
    elapsed, _ = wait_window(proc, 90, min_size=400)
    entry["editor_window_s"] = elapsed
    if theme_shot:
        time.sleep(4)
        entry["shot_editor"] = screenshot(theme_shot)
    t_req = wait_log(proc, "auto editor export requested", 180)
    t_done = wait_log(proc, "editor tracks export completed" if kind == "tracks" else "editor export completed", 900) if t_req else None
    entry["export_s"] = round(t_done - t_req, 2) if (t_req and t_done) else None
    entry["playback_log"] = tail(proc, 6, grep=["playback", "Playback"])
    entry["hover_log"] = tail(proc, 8, grep=["hover analysis"])
    entry["log_errors"] = tail(proc, 12, grep=["ERROR", "panicked"])
    kill(proc)
    if kind == "tracks":
        entry["outputs"] = {p.name: ffprobe(p) for p in sorted(target.rglob("*")) if p.is_file()}
    else:
        candidates = [target] if target.exists() else sorted(out_dir.glob(f"*{target.suffix}"))
        entry["outputs"] = {p.name: ffprobe(p) for p in candidates}
        if kind == "gif" and target.exists():
            entry["gif_bytes"] = target.stat().st_size
    return entry


def flow_studio():
    recorded = {}
    for side in SIDES:
        sb, entry = studio_record(side, f"studio-{side}", shot_prefix="studio")
        record("studio", side, entry)
        log("studio", side, entry.get("finished"), entry.get("status"))
        if entry.get("project"):
            recorded[side] = (sb, Path(entry["project"]))
    for rnd in range(3):
        for side in (SIDES if rnd % 2 == 0 else SIDES[::-1]):
            if side in recorded:
                sb, project = recorded[side]
                e = editor_export(side, sb, project, "mp4", theme_shot=f"editor-light-{side}" if rnd == 0 else None)
                e["round"] = rnd
                record("export", side, e)
                log("export mp4", side, rnd, e.get("export_s"))
    for side in SIDES:
        if side not in recorded:
            continue
        sb, project = recorded[side]
        record("export", side, editor_export(side, sb, project, "gif"))
        if side == "head":
            record("export", side, editor_export(side, sb, project, "tracks"))
        dark = Sandbox(f"studio-dark-view-{side}", theme="dark")
        shutil.copytree(project, dark.root / "recordings" / project.name)
        for tab, panel in (("audio", None), (None, "clips")):
            env = {"CAP_GPUI_AUTO_EDITOR": str(dark.root / "recordings" / project.name)}
            if tab:
                env["CAP_GPUI_AUTO_SIDEBAR"] = tab
            if panel:
                env["CAP_GPUI_AUTO_PANEL"] = panel
            for theme_sb, theme in ((dark, "dark"), (sb, "light")):
                if theme_sb is sb:
                    env["CAP_GPUI_AUTO_EDITOR"] = str(project)
                else:
                    env["CAP_GPUI_AUTO_EDITOR"] = str(dark.root / "recordings" / project.name)
                proc = theme_sb.launch(side, f"view-{tab or panel}-{theme}", env)
                wait_window(proc, 90, min_size=400)
                time.sleep(7)
                record("ui", side, {"what": f"editor {tab or panel} {theme}", "shot": screenshot(f"editor-{tab or panel}-{theme}-{side}")})
                kill(proc)
        sb2, e2 = studio_record(side, f"overlay-dark-{side}", theme="dark", secs=6, shot_prefix="overlay-dark")
        record("ui", side, {"what": "after studio recording, dark", "shot": e2.get("shot_after"), "windows": e2.get("windows_after")})


def project_mode(project):
    try:
        meta = json.loads((project / "recording-meta.json").read_text())
    except Exception:  # noqa: BLE001
        meta = None
    if isinstance(meta, dict) and ("segments" in meta or "segment" in meta):
        return "studio"
    if isinstance(meta, dict) and any(k in meta for k in ("recording", "fps", "error")):
        return "instant"
    if (project / "instant-upload.json").exists():
        return "instant"
    if list(project.glob("content/segments/*")) or (project / "content" / "display").exists():
        return "studio"
    return "unknown" if meta is None else "meta:" + ",".join(sorted(meta.keys())[:8])


def flow_hotkeys():
    """#3599: a Start Studio / Start Instant shortcut records in its own mode
    and leaves the selected mode alone; Start Recording follows the selection."""
    cases = [
        ("instant", "startStudioRecording", "studio"),
        ("studio", "startInstantRecording", "instant"),
        ("instant", "startRecording", "instant"),
        ("studio", "startRecording", "studio"),
    ]
    for rnd in range(2):
        for selected, action, expected in cases:
            for side in (SIDES if rnd % 2 == 0 else SIDES[::-1]):
                mock = Mock(f"hk-{side}-{rnd}-{selected}-{action}")
                sb = Sandbox(f"hk-{side}-{rnd}-{selected}-{action}", server=mock.url, store={"recording_settings": {"mode": selected}})
                env = record_env()
                env["CAP_GPUI_AUTO_HOTKEY"] = action
                if OS == "Linux":
                    # Xvfb has no display capture path; record the xmessage window
                    # the shortcut would find as the remembered target.
                    xid = subprocess.run(["xdotool", "search", "--class", "xmessage"], capture_output=True, text=True).stdout.split()
                    if xid:
                        doc = json.loads((sb.root / "store").read_text())
                        doc["recording_settings"]["target"] = {"variant": "window", "id": xid[0]}
                        (sb.root / "store").write_text(json.dumps(doc))
                proc = sb.launch(side, "hotkey", env)
                entry = {"round": rnd, "selected": selected, "action": action, "expected": expected}
                t_key = wait_log(proc, "global hotkey", 60) or wait_log(proc, "CAP_GPUI_AUTO_HOTKEY", 5)
                entry["dispatched"] = t_key is not None
                t_rec = wait_log(proc, "recording started", 45)
                entry["recording_started"] = t_rec is not None
                if t_key and t_rec:
                    entry["key_to_recording_s"] = round(t_rec - t_key, 2)
                time.sleep(6)
                try:
                    store_mode = json.loads((sb.root / "store").read_text()).get("recording_settings", {}).get("mode")
                except Exception:  # noqa: BLE001
                    store_mode = "unreadable"
                entry["selected_after"] = store_mode
                entry["log"] = tail(proc, 10, grep=["hotkey", "HOTKEY", "recording started", "ERROR", "panicked"])
                if not entry["recording_started"]:
                    logs = OUT / "logs"
                    logs.mkdir(exist_ok=True)
                    (logs / f"hotkey-{side}-{rnd}-{selected}-{action}.log").write_text(text(proc)[-20000:])
                kill(proc)
                mock.finish()
                projects = sb.projects()
                entry["projects"] = len(projects)
                entry["recorded_mode"] = project_mode(projects[0]) if projects else None
                entry["mode_ok"] = entry["recorded_mode"] == expected
                entry["selection_kept"] = store_mode == selected
                record("hotkeys", side, entry)
                log("hotkey", side, rnd, selected, action, "->", entry["recorded_mode"], "selected after", store_mode)


def finished_display_segments(sb):
    best = 0
    for project in sb.projects():
        manifests = list(project.glob("content/display/manifest.json")) + list(project.glob("content/segments/*/display/manifest.json"))
        for manifest in manifests:
            try:
                segments = json.loads(manifest.read_text()).get("segments", [])
            except Exception:  # noqa: BLE001
                continue
            best = max(best, sum(1 for seg in segments if seg.get("is_complete") is True))
    return best


def wait_segments(sb, proc, count, timeout):
    t0 = time.monotonic()
    for _ in range(int(timeout * 4)):
        if proc.poll() is not None:
            return None
        if finished_display_segments(sb) >= count:
            return round(time.monotonic() - t0, 1)
        time.sleep(0.25)
    return None


def kill_after_segments(sb, proc, entry):
    if wait_log(proc, "auto-record start requested", 90):
        entry["killed_after_s"] = wait_segments(sb, proc, 4, 80)
        entry["finished_segments_at_kill"] = finished_display_segments(sb)
        time.sleep(1.5)
    kill(proc)


def flow_recovery():
    for side in SIDES:
        # Studio
        sb = Sandbox(f"recover-studio-{side}")
        env = record_env()
        env["CAP_GPUI_AUTO_RECORD"] = "studio:120"
        proc = sb.launch(side, "record", env)
        entry = {"mode": "studio"}
        kill_after_segments(sb, proc, entry)
        projects = sb.projects()
        entry["projects_before"] = [p.name for p in projects]
        if projects:
            project = projects[0]
            entry["files_before"] = file_list(project)
            entry["status_before"] = meta_status(project)
            proc = sb.launch(side, "recover", {"CAP_GPUI_AUTO_RECOVER": "1"})
            wait_window(proc, 90)
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                status = meta_status(project)
                if status is not None and "InProgress" not in json.dumps(status) and "NeedsRemux" not in json.dumps(status):
                    break
                time.sleep(0.5)
            time.sleep(3)
            entry["shot"] = screenshot(f"recover-studio-{side}")
            entry["recover_log"] = tail(proc, 12, grep=["recover", "Recover", "incomplete", "ERROR"])
            kill(proc)
            entry["projects_after"] = [p.name for p in sb.projects()]
            entry["status_after"] = meta_status(project)
            after = file_list(project)
            entry["files_after"] = after
            entry["lost_files"] = sorted(set(entry["files_before"]) - set(after))
            entry["local_media"] = local_media(project)
        record("recovery", side, entry)
        log("recovery studio", side, entry.get("status_after"))

        # Instant
        mock = Mock(f"recover-instant-{side}")
        sb = Sandbox(f"recover-instant-{side}", server=mock.url)
        env = record_env()
        env["CAP_GPUI_AUTO_RECORD"] = "instant:120"
        proc = sb.launch(side, "record", env)
        entry = {"mode": "instant"}
        kill_after_segments(sb, proc, entry)
        projects = sb.projects()
        entry["projects_before"] = [p.name for p in projects]
        if projects:
            project = projects[0]
            entry["files_before"] = file_list(project)
            proc = sb.launch(side, "recover", {"CAP_GPUI_AUTO_RECOVER": "1"})
            deadline = time.monotonic() + 300
            verified = False
            while time.monotonic() < deadline:
                try:
                    if json.loads((project / "instant-upload.json").read_text()).get("phase") == "Verified":
                        verified = True
                        break
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.5)
            entry["verified"] = verified
            entry["recover_log"] = tail(proc, 12, grep=["recover", "Recover", "incomplete", "ERROR"])
            kill(proc)
            entry["projects_after"] = [p.name for p in sb.projects()]
            after = file_list(project)
            entry["files_after"] = after
            entry["lost_files"] = sorted(
                k for k in entry["files_before"] if k not in after and k + ".unsealed" not in after and not k.endswith((".tmp", ".unsealed"))
            )
            entry["set_aside"] = sorted(k for k in after if k.endswith(".unsealed"))
            try:
                entry["upload_state"] = json.loads((project / "instant-upload.json").read_text())
            except Exception:  # noqa: BLE001
                pass
            entry["local_media"] = local_media(project)
        summary = mock.finish()
        entry["server"] = {"confirmed": len(summary.get("confirmations") or []), "deleted": summary.get("deleted")}
        entry["uploaded_media"] = mock.uploaded_media()
        record("recovery", side, entry)
        log("recovery instant", side, entry.get("verified"))


def flow_ui():
    for side in SIDES:
        for theme in ("light", "dark"):
            sb = Sandbox(f"ui-settings-{side}-{theme}", theme=theme)
            proc = sb.launch(side, "feedback", {"CAP_GPUI_AUTO_SETTINGS": "feedback"})
            wait_window(proc, 60)
            time.sleep(6)
            record("ui", side, {"what": f"settings feedback {theme}", "shot": screenshot(f"settings-feedback-{theme}-{side}")})
            kill(proc)

            sb = Sandbox(f"ui-area-{side}-{theme}", theme=theme)
            proc = sb.launch(side, "area", {"CAP_GPUI_AUTO_OVERLAY": "area", "CAP_GPUI_AUTO_AREA": "300,200,800,450"})
            wait_window(proc, 60)
            time.sleep(7)
            record("ui", side, {"what": f"area overlay {theme}", "shot": screenshot(f"area-{theme}-{side}")})
            kill(proc)

            sb = Sandbox(f"ui-general-{side}-{theme}", theme=theme)
            proc = sb.launch(side, "general", {"CAP_GPUI_AUTO_SETTINGS": "general"})
            wait_window(proc, 60)
            time.sleep(6)
            record("ui", side, {"what": f"settings general {theme}", "shot": screenshot(f"settings-general-{theme}-{side}")})
            kill(proc)
    if OS != "Linux":
        for theme in ("light", "dark"):
            mock = Mock(f"tray-{theme}")
            sb = Sandbox(f"ui-tray-{theme}", server=mock.url, theme=theme)
            proc = sb.launch("head", "tray", {"CAP_GPUI_AUTO_TRAY": "upload_logs"}, tray=True)
            wait_window(proc, 60)
            time.sleep(12)
            entry = {"what": f"tray upload logs {theme}", "shot": screenshot(f"tray-upload-logs-{theme}-head"), "log": tail(proc, 8, grep=["log", "Log"])}
            kill(proc)
            summary = mock.finish()
            entry["server_objects"] = len(summary.get("objects") or [])
            record("ui", "head", entry)


def flow_automations():
    if OS == "Linux":
        return
    env = dict(os.environ)
    env["CAP_GPUI_REAL_APP_BIN"] = str(app_bin("head"))
    env["CAP_GPUI_REAL_APP_ARTIFACTS"] = str(WORK / "automation-sandboxes")
    lib_env(env, HARNESS)
    t0 = time.monotonic()
    run = subprocess.run(
        [str(harness_bin()), "--ignored", "--test-threads=1", "real_app_automation"],
        env=env,
        capture_output=True,
        text=True,
        timeout=2400,
    )
    lines = (run.stdout + run.stderr).splitlines()
    record(
        "automations",
        "head",
        {
            "exit": run.returncode,
            "seconds": round(time.monotonic() - t0, 1),
            "results": [line for line in lines if line.startswith("test ") or "test result" in line],
            "failures": [line for line in lines if "panicked" in line][:10],
        },
    )
    log("automations", run.returncode)


def marker_action(path):
    if OS == "Windows":
        return {"type": "runCommand", "program": "powershell.exe", "args": ["-NoProfile", "-Command", f"New-Item -ItemType File -Force -Path '{path}' | Out-Null"]}
    return {"type": "runCommand", "program": "/bin/sh", "args": ["-c", f"touch '{path}'"]}


def export_action(destination):
    return {
        "type": "export",
        "profile": {"format": "mp4", "fps": 30, "resolutionBase": {"x": 1280, "y": 720}, "compression": "potato", "presetName": None},
        "destination": destination,
    }


def rule(rid, actions):
    return {"id": rid, "name": rid, "enabled": True, "trigger": "studioRecordingFinished", "actions": actions}


def flow_automations_native():
    """The export-then-delete rule in the shipped app, without a POSIX shell."""
    # Safe copy: the recording is deleted only once the copy is saved.
    sb = Sandbox("auto-safe")
    out = sb.root / "compressed"
    last = sb.root / "last-rule-ran"
    sb_store = json.loads((sb.root / "store").read_text())
    sb_store["automations"] = {"version": 1, "rules": [rule("compress", [export_action({"customPath": {"dir": str(out)}}), {"type": "deleteLocalFiles"}]), rule("last", [marker_action(last)])]}
    (sb.root / "store").write_text(json.dumps(sb_store))
    env = record_env()
    env["CAP_GPUI_AUTO_RECORD"] = "studio:5"
    proc = sb.launch("head", "auto-safe", env)
    t0 = time.monotonic()
    done = False
    for _ in range(960):
        exported = sorted(out.glob("*.mp4")) if out.exists() else []
        if last.exists() and exported and not sb.projects():
            done = True
            break
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    log_lines = tail(proc, 30, grep=["automation"])
    kill(proc)
    exported = sorted(out.glob("*.mp4")) if out.exists() else []
    record(
        "automations_native",
        "head",
        {
            "case": "safe copy then delete",
            "done": done,
            "seconds": round(time.monotonic() - t0, 1),
            "export": {p.name: ffprobe(p) for p in exported},
            "projects_left": [p.name for p in sb.projects()],
            "last_rule_ran": last.exists(),
            "log": log_lines,
        },
    )

    # Unsafe copies: export inside the recording, and an export that fails.
    sb = Sandbox("auto-unsafe")
    last = sb.root / "last-rule-ran"
    bad = r"Z:\cannot\exist" if OS == "Windows" else "/dev/null/cannot-exist"
    sb_store = json.loads((sb.root / "store").read_text())
    sb_store["automations"] = {
        "version": 1,
        "rules": [
            rule("inside", [{"type": "skipEditor"}, export_action("projectFolder"), {"type": "deleteLocalFiles"}]),
            rule("failed", [export_action({"customPath": {"dir": bad}}), {"type": "deleteLocalFiles"}]),
            rule("last", [marker_action(last)]),
        ],
    }
    (sb.root / "store").write_text(json.dumps(sb_store))
    proc = sb.launch("head", "auto-unsafe", env)
    for _ in range(960):
        if last.exists() or proc.poll() is not None:
            break
        time.sleep(0.25)
    time.sleep(2)
    full = text(proc)
    kill(proc)
    projects = sb.projects()
    record(
        "automations_native",
        "head",
        {
            "case": "unsafe copies keep the recording",
            "last_rule_ran": last.exists(),
            "projects_left": [p.name for p in projects],
            "media_left": {k: v for k, v in (file_list(projects[0]) if projects else {}).items() if k.endswith((".mp4", ".m4a", ".m4s"))},
            "refused_inside": "inside the folder that would be deleted" in full,
            "refused_failed": "export did not succeed" in full,
            "deleted_anything": "automation: deleting local recording" in full,
            "log": [line for line in full.splitlines() if "automation" in line][-20:],
        },
    )
    log("automations native done")


def click(x, y):
    subprocess.run([os.environ.get("RC064_CLICK", str(WORK / "click")), str(x), str(y)], timeout=10)


def flow_barmenu():
    if OS != "Darwin":
        return
    for theme in ("light", "dark"):
        for side in SIDES:
            sb = Sandbox(f"bar-{side}-{theme}", theme=theme)
            env = record_env()
            env["CAP_GPUI_AUTO_RECORD"] = "studio:30"
            proc = sb.launch(side, "record", env)
            entry = {"what": f"recording bar settings menu {theme}"}
            if wait_log(proc, "auto-record start requested", 90):
                time.sleep(5)
                wins = visible_windows(proc.pid)
                bars = [w for w in wins if 20 <= w[3] <= 90 and 120 <= w[2] <= 600]
                entry["windows_before"] = wins
                if bars:
                    x, y, w, h, _ = bars[0]
                    entry["shot_bar"] = screenshot(f"bar-{theme}-{side}")
                    click(x + w * 0.878, y + h / 2)
                    time.sleep(2)
                    entry["clicked"] = [x + w * 0.878, y + h / 2]
                    entry["windows_after"] = visible_windows(proc.pid)
                    entry["shot"] = screenshot(f"bar-menu-{theme}-{side}")
            entry["log"] = tail(proc, 8, grep=["settings", "menu", "Settings"])
            kill(proc)
            record("ui", side, entry)


def build_helpers():
    if OS == "Darwin":
        click_src = WORK / "click.swift"
        click_src.write_text(
            """
import CoreGraphics
import Foundation
let x = Double(CommandLine.arguments[1])!
let y = Double(CommandLine.arguments[2])!
let p = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .hidSystemState)
CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(150000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(80000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
"""
        )
        subprocess.run(["swiftc", "-O", "-o", os.environ.get("RC064_CLICK", str(WORK / "click")), str(click_src)], check=True)
        src = WORK / "winlist.swift"
        src.write_text(
            """
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int32, owner == pid else { continue }
    let b = w[kCGWindowBounds as String] as! [String: Any]
    let name = w[kCGWindowName as String] as? String ?? ""
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    print("\\(b["X"]!)\\t\\(b["Y"]!)\\t\\(b["Width"]!)\\t\\(b["Height"]!)\\t\\(name) layer=\\(layer)")
}
"""
        )
        subprocess.run(["swiftc", "-O", "-o", str(WORK / "winlist"), str(src)], check=True)


def set_export_prefs(sb, prefs):
    path = sb.root / "gpui-state.json"
    try:
        doc = json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        doc = {}
    if prefs is None:
        doc.pop("export", None)
    else:
        doc["export"] = prefs
    path.write_text(json.dumps(doc))


EXPORT_4K = {"format": "Mp4", "fps": 60, "export_to": "file", "resolution": "4K", "compression": "Maximum", "custom_bpp": None}


def target_window():
    """Opens a plain window of our own to record; returns (env, cleanup)."""
    if OS == "Linux":
        return {"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": "xmessage"}, (lambda: None)
    if OS == "Darwin":
        title = f"gate064-target-{os.getpid()}"
        doc = WORK / title
        doc.write_text("The window Cap records\n" * 20)
        before = set(subprocess.run(["pgrep", "-x", "TextEdit"], capture_output=True, text=True).stdout.split())
        subprocess.run(["open", "-n", "-a", "TextEdit", str(doc)])
        time.sleep(4)
        ours = [p for p in subprocess.run(["pgrep", "-x", "TextEdit"], capture_output=True, text=True).stdout.split() if p not in before]

        def cleanup():
            for p in ours:
                subprocess.run(["kill", p])

        return {"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": title}, cleanup
    doc = WORK / "gate064-target.txt"
    doc.write_text("The window Cap records\r\n" * 20)
    proc = subprocess.Popen(["notepad.exe", str(doc)])
    time.sleep(4)
    wins = visible_windows(proc.pid)
    title = wins[0][4] if wins else "gate064-target.txt - Notepad"
    log("notepad window", wins)
    return {"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": title}, (lambda: kill(proc))


def flow_targets():
    """Studio display, window and area targets, 12 s each, both builds."""
    for rnd in range(2):
        for side in (SIDES if rnd % 2 == 0 else SIDES[::-1]):
            for target in ("display", "window", "area"):
                cleanup = lambda: None  # noqa: E731
                if target == "display":
                    env = {"CAP_GPUI_AUTO_OVERLAY": "display"}
                    if OS == "Windows":
                        env["CAP_GPUI_AUTO_NO_MIC"] = "1"
                elif target == "window":
                    env, cleanup = target_window()
                    if OS == "Windows":
                        env["CAP_GPUI_AUTO_NO_MIC"] = "1"
                else:
                    env = {"CAP_GPUI_AUTO_OVERLAY": "area", "CAP_GPUI_AUTO_AREA": "200,150,1000,600"}
                    if OS == "Windows":
                        env["CAP_GPUI_AUTO_NO_MIC"] = "1"
                sb = Sandbox(f"target-{target}-{side}-{rnd}", general={"postStudioRecordingBehaviour": "showOverlay"})
                env["CAP_GPUI_AUTO_RECORD"] = "studio:12"
                proc = sb.launch(side, f"target-{target}", env)
                entry = {"target": target, "round": rnd}
                t_start = wait_log(proc, "auto-record start requested", 90)
                entry["started"] = t_start is not None
                if t_start:
                    time.sleep(4)
                    if rnd == 0:
                        entry["shot_recording"] = screenshot(f"target-{target}-recording-{side}")
                    with Sampler(proc.pid) as s:
                        t_stop = wait_log(proc, "auto-record stop requested", 80)
                    entry["recording_resources"] = s.summary()
                    done = wait_log(proc, "auto-record main window after the recording", 120)
                    entry["finished"] = done is not None
                    if t_stop and done:
                        entry["stop_to_idle_s"] = round(done - t_stop, 2)
                entry["log_errors"] = tail(proc, 12, grep=["ERROR", "panicked"])
                kill(proc)
                cleanup()
                projects = sb.projects()
                if projects:
                    entry["status"] = meta_status(projects[0])
                    entry["local_media"] = local_media(projects[0])
                record("targets", side, entry)
                log("target", target, side, rnd, entry.get("finished"), entry.get("status"))


def flow_export4k():
    """Default and 4K MP4 exports of one fresh Studio recording per build, alternating."""
    recorded = {}
    for side in SIDES:
        sb, entry = studio_record(side, f"e4k-{side}", secs=20)
        record("export4k_source", side, entry)
        if entry.get("project"):
            recorded[side] = (sb, Path(entry["project"]))
    for rnd in range(1 if OS == "Windows" else 2):
        for side in (SIDES if rnd % 2 == 0 else SIDES[::-1]):
            if side not in recorded:
                continue
            sb, project = recorded[side]
            for label, prefs in (("default", None), ("4k", EXPORT_4K)):
                set_export_prefs(sb, prefs)
                e = editor_export(side, sb, project, "mp4")
                e["round"] = rnd
                e["preset"] = label
                record("export4k", side, e)
                log("export", label, side, rnd, e.get("export_s"))
            set_export_prefs(sb, None)


def flow_ux():
    """Screenshots of the main surfaces, light and dark, both builds."""
    pages = ["general", "quality", "hotkeys", "recordings", "screenshots", "automations", "transcription", "integrations", "experimental", "license", "feedback", "changelog"]
    for side in SIDES:
        for theme in ("light", "dark"):
            side_pages = pages + (["meetings"] if side == "head" else [])
            for page in side_pages:
                sb = Sandbox(f"ux-{page}-{side}-{theme}", theme=theme)
                proc = sb.launch(side, f"settings-{page}", {"CAP_GPUI_AUTO_SETTINGS": page})
                wait_window(proc, 60)
                time.sleep(4)
                record("ux", side, {"what": f"settings {page} {theme}", "shot": screenshot(f"ux-settings-{page}-{theme}-{side}"), "windows": visible_windows(proc.pid)})
                kill(proc)
            if side == "head":
                for page in ("home", "recordings", "notes"):
                    sb = Sandbox(f"ux-lib-{page}-{side}-{theme}", theme=theme)
                    proc = sb.launch(side, f"library-{page}", {"CAP_GPUI_AUTO_LIBRARY": page})
                    wait_window(proc, 60)
                    time.sleep(5)
                    record("ux", side, {"what": f"library {page} {theme}", "shot": screenshot(f"ux-library-{page}-{theme}-{side}"), "windows": visible_windows(proc.pid), "log_errors": tail(proc, 6, grep=["ERROR", "panicked"])})
                    kill(proc)
            for mode in ("1",):
                sb = Sandbox(f"ux-mode-{side}-{theme}", theme=theme)
                proc = sb.launch(side, "mode-select", {"CAP_GPUI_AUTO_MODE_SELECT": mode})
                wait_window(proc, 60)
                time.sleep(4)
                record("ux", side, {"what": f"mode select {theme}", "shot": screenshot(f"ux-mode-{theme}-{side}")})
                kill(proc)


def flow_editor_ux():
    """Editor + export page shots on one Studio recording per build."""
    for side in SIDES:
        sb, entry = studio_record(side, f"edux-{side}", secs=8)
        if not entry.get("project"):
            record("ux", side, {"what": "editor ux: no project", "entry": entry})
            continue
        project = Path(entry["project"])
        for theme in ("light", "dark"):
            view = Sandbox(f"edux-view-{side}-{theme}", theme=theme)
            shutil.copytree(project, view.root / "recordings" / project.name)
            p = view.root / "recordings" / project.name
            for label, env in (
                ("editor", {}),
                ("export", {"CAP_GPUI_AUTO_EXPORT_PAGE": "advanced"}),
                ("export-link", {"CAP_GPUI_AUTO_EXPORT_PAGE": "link"}),
                ("captions", {"CAP_GPUI_AUTO_SIDEBAR": "captions"}),
            ):
                e = {"CAP_GPUI_AUTO_EDITOR": str(p)}
                e.update(env)
                proc = view.launch(side, f"edux-{label}", e)
                wait_window(proc, 90, min_size=400)
                time.sleep(7)
                record("ux", side, {"what": f"editor {label} {theme}", "shot": screenshot(f"ux-editor-{label}-{theme}-{side}"), "log_errors": tail(proc, 6, grep=["ERROR", "panicked"])})
                kill(proc)


def display_stats(media):
    """frames / seconds / fps of the screen track(s) in local_media output."""
    out = {}
    for name, probe in (media or {}).items():
        if "display" not in name and "screen" not in name and not name.endswith("output.mp4"):
            continue
        for s in probe.get("streams", []):
            if s.get("codec_type") == "video":
                try:
                    frames = int(s.get("nb_frames") or 0)
                    dur = float(s.get("duration") or probe.get("duration") or 0)
                except (TypeError, ValueError):
                    continue
                out[name] = {"frames": frames, "secs": round(dur, 2), "fps": round(frames / dur, 2) if dur else None, "size": f"{s.get('width')}x{s.get('height')}"}
    return out


def wait_finalized(sb, timeout):
    """Monotonic time when the newest project's recording-meta says Complete."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        projects = sb.projects()
        if projects and "Complete" in json.dumps(meta_status(projects[-1])):
            return time.monotonic()
        time.sleep(0.1)
    return None


def perf_record(side, label, mode, fps, secs, mic, cam=False):
    sb = Sandbox(f"perf-{label}-{side}-{int(time.time())}", general={"maxFps": fps, "postStudioRecordingBehaviour": "showOverlay"})
    env = {} if OS != "Linux" else {"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": "xmessage"}
    if not mic:
        env["CAP_GPUI_AUTO_NO_MIC"] = "1"
    env["CAP_GPUI_AUTO_RECORD"] = f"{mode}:{secs}"
    if cam:
        env["CAP_GPUI_AUTO_CAMERA"] = "1"
    server = None
    if mode == "instant":
        server = Mock(f"perf-{label}-{side}-{int(time.time())}")
        sb = Sandbox(f"perf-{label}-{side}-{int(time.time())}", server=server.url, general={"maxFps": fps})
    stim = subprocess.Popen(os.environ["GATE_STIM"], shell=True) if os.environ.get("GATE_STIM") else None
    proc = sb.launch(side, f"perf-{label}", env)
    entry = {"label": label, "mode": mode, "fps_setting": fps, "secs": secs, "mic": mic}
    t_start = wait_log(proc, "auto-record start requested", 90)
    entry["started"] = t_start is not None
    if t_start:
        time.sleep(2)
        with Sampler(proc.pid) as s:
            t_stop = wait_log(proc, "auto-record stop requested", secs + 60)
        entry["recording_resources"] = s.summary()
        if mode == "studio":
            done = wait_finalized(sb, 120)
            if t_stop and done:
                entry["stop_to_complete_s"] = round(done - t_stop, 2)
            idle = wait_log(proc, "auto-record main window after the recording", 3)
            if t_stop and idle:
                entry["stop_to_idle_s"] = round(idle - t_stop, 2)
        else:
            deadline = time.monotonic() + 240
            while time.monotonic() < deadline:
                projects = sb.projects()
                try:
                    state = json.loads((projects[0] / "instant-upload.json").read_text()) if projects else None
                except Exception:  # noqa: BLE001
                    state = None
                if state and state.get("phase") == "Verified":
                    if t_stop:
                        entry["stop_to_verified_s"] = round(time.monotonic() - t_stop, 2)
                    break
                time.sleep(0.25)
    entry["log_errors"] = tail(proc, 8, grep=["ERROR", "panicked"])
    kill(proc)
    if stim:
        kill(stim)
        shell(os.environ.get("GATE_STIM_KILL"))
    if server:
        server.finish()
    projects = sb.projects()
    if projects:
        entry["status"] = meta_status(projects[0])
        media = local_media(projects[0])
        entry["display"] = display_stats(media)
        entry["project"] = str(projects[0])
    return sb, entry


def perf_playback(side, sb, project):
    env = {"CAP_GPUI_AUTO_EDITOR": str(project), "CAP_GPUI_AUTO_PLAYBACK": "16", "CAP_GPUI_AUTO_FRAME_STATS": "14"}
    proc = sb.launch(side, "perf-play", env)
    entry = {}
    elapsed, _ = wait_window(proc, 90, min_size=400)
    entry["editor_window_s"] = round(elapsed, 3) if elapsed else None
    t_play = wait_log(proc, "auto playback: playing", 120)
    if t_play:
        time.sleep(3)
        with Sampler(proc.pid) as s:
            time.sleep(10)
        entry["playback_resources"] = s.summary()
        time.sleep(5)
    entry["frame_stats"] = tail(proc, 4, grep=["frame stats", "playback fps"])
    entry["log_errors"] = tail(proc, 6, grep=["ERROR", "panicked"])
    kill(proc)
    return entry


def flow_playab():
    """One project (recorded by the oldest build) played by every build, rotated."""
    rounds = int(os.environ.get("GATE_PLAY_ROUNDS", "6"))
    src_side = SIDES[0]
    cam = os.environ.get("GATE_PLAY_CAMERA") == "1"
    sb, entry = perf_record(src_side, "playsrc", "studio", 60, 30, False, cam=cam)
    record("playab_source", src_side, entry)
    if not entry.get("project"):
        return
    project = Path(entry["project"])
    for rnd in range(rounds):
        order = SIDES[rnd % len(SIDES):] + SIDES[: rnd % len(SIDES)]
        for side in order:
            view = Sandbox(f"playab-{side}-{rnd}")
            dest = view.root / "recordings" / project.name
            shutil.copytree(project, dest)
            for warm in (False, True):
                e = perf_playback(side, view, dest)
                e["round"] = rnd
                e["warm"] = warm
                e["camera"] = cam
                e["hover"] = tail_file(view, "hover analysis")
                record("playab", side, e)
                log("playab", side, rnd, "warm" if warm else "cold", g_cpu(e))
            idle = editor_idle(side, view, dest)
            idle["round"] = rnd
            record("editor_idle", side, idle)


EXPORT_1080 = {"format": "Mp4", "fps": 60, "export_to": "file", "resolution": "1080p", "compression": "Maximum", "custom_bpp": None}


def flow_exportab():
    """One project (recorded by the oldest build) exported by every build with
    the same saved settings, rotated. GATE_EXPORT_PRESET=4k|1080, rounds."""
    rounds = int(os.environ.get("GATE_EXPORT_ROUNDS", "4"))
    preset = os.environ.get("GATE_EXPORT_PRESET", "1080" if OS == "Windows" else "4k")
    prefs = {"4k": EXPORT_4K, "1080": EXPORT_1080}.get(preset)
    src_fps = int(os.environ.get("GATE_SRC_FPS", "60"))
    src_side = SIDES[0]
    sb, entry = perf_record(src_side, f"exsrc{src_fps}", "studio", src_fps, 20, OS != "Windows")
    record("exportab_source", src_side, entry)
    if not entry.get("project"):
        return
    project = Path(entry["project"])
    for rnd in range(rounds):
        order = SIDES[rnd % len(SIDES):] + SIDES[: rnd % len(SIDES)]
        for side in order:
            view = Sandbox(f"exab-{side}-{rnd}")
            dest = view.root / "recordings" / project.name
            shutil.copytree(project, dest)
            set_export_prefs(view, prefs)
            with Sampler_after_window(view, side) as holder:
                e = editor_export(side, view, dest, "mp4")
            e["round"] = rnd
            e["preset"] = preset
            e["src_fps"] = src_fps
            for name, probe in (e.get("outputs") or {}).items():
                try:
                    e["bytes"] = (WORK / f"exports-{side}" / name).stat().st_size
                except OSError:
                    pass
            record("exportab", side, e)
            log("exportab", side, rnd, e.get("export_s"))


class Sampler_after_window:
    def __init__(self, sb, side):
        self.sb, self.side = sb, side

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def tail_file(sb, needle):
    out = []
    for f in sorted(sb.root.glob("*.log")):
        for line in f.read_text(errors="replace").splitlines():
            if needle in line:
                out.append(line[-160:])
    return out[-4:]


def editor_idle(side, sb, project):
    """Editor open on the project, not playing: CPU from +5 s to +20 s."""
    proc = sb.launch(side, "editor-idle", {"CAP_GPUI_AUTO_EDITOR": str(project)})
    wait_window(proc, 90, min_size=400)
    time.sleep(5)
    with Sampler(proc.pid) as s:
        time.sleep(15)
    entry = {"idle_resources": s.summary()}
    kill(proc)
    return entry


def g_cpu(e):
    return (e.get("playback_resources") or {}).get("cpu_mean_pct")


def rss_by_mapping(pid):
    """Linux: RSS kB per mapping name (binary, libs, [heap], anon) incl. children."""
    out = {}
    try:
        procs = [psutil.Process(pid)] + psutil.Process(pid).children(recursive=True)
    except psutil.Error:
        return out
    for p in procs:
        try:
            name = None
            for line in open(f"/proc/{p.pid}/smaps"):
                parts = line.split()
                if not parts:
                    continue
                if "-" in parts[0] and len(parts) >= 5 and not parts[0].endswith(":"):
                    path = parts[5] if len(parts) > 5 else "[anon]"
                    name = os.path.basename(path) if path.startswith("/") else path
                elif parts[0] == "Rss:" and name:
                    out[name] = out.get(name, 0) + int(parts[1])
        except OSError:
            continue
    return dict(sorted(out.items(), key=lambda kv: -kv[1])[:40])


def flow_memmap():
    """Idle memory by mapping, 3 rounds rotated (Linux: smaps; macOS: footprint)."""
    for rnd in range(3):
        order = SIDES[rnd % len(SIDES):] + SIDES[: rnd % len(SIDES)]
        for side in order:
            sb = Sandbox(f"memmap-{side}-{rnd}")
            proc = sb.launch(side, "memmap")
            wait_window(proc, 90)
            time.sleep(10)
            entry = {"round": rnd}
            try:
                p = psutil.Process(proc.pid)
                entry["rss_mb"] = round(sum(x.memory_info().rss for x in [p] + p.children(recursive=True)) / 1048576, 1)
                entry["threads"] = p.num_threads()
                entry["children"] = [c.name() for c in p.children(recursive=True)]
            except psutil.Error:
                pass
            if OS == "Linux":
                entry["by_mapping_kb"] = rss_by_mapping(proc.pid)
            elif OS == "Darwin":
                r = subprocess.run(["footprint", str(proc.pid)], capture_output=True, text=True, timeout=60)
                entry["footprint"] = r.stdout[-3000:]
            entry["log_tail"] = tail(proc, 30)
            kill(proc)
            record("memmap", side, entry)
            log("memmap", side, rnd, entry.get("rss_mb"), entry.get("threads"))


def thread_names(pid):
    if OS != "Linux":
        return None
    names = {}
    try:
        for t in os.listdir(f"/proc/{pid}/task"):
            try:
                n = open(f"/proc/{pid}/task/{t}/comm").read().strip()
            except OSError:
                continue
            names[n] = names.get(n, 0) + 1
    except OSError:
        return None
    return dict(sorted(names.items()))


def flow_idle60():
    """Main window open, nothing touched, Notes never enabled: 60 s of idle.
    CPU seconds, context switches (wakeups), threads, sockets, Notes logs."""
    for rnd in range(int(os.environ.get("GATE_IDLE_ROUNDS", "3"))):
        order = SIDES[rnd % len(SIDES):] + SIDES[: rnd % len(SIDES)]
        for side in order:
            sb = Sandbox(f"idle60-{side}-{rnd}")
            proc = sb.launch(side, "idle60", {"RUST_LOG": "info"})
            wait_window(proc, 90)
            time.sleep(10)
            entry = {"round": rnd}
            try:
                p = psutil.Process(proc.pid)
                t0 = p.cpu_times()
                c0 = p.num_ctx_switches()
                entry["threads_start"] = p.num_threads()
                entry["thread_names"] = thread_names(proc.pid)
                conns = set()
                rss = []
                for _ in range(12):
                    time.sleep(5)
                    try:
                        for c in (getattr(p, "net_connections", None) or p.connections)(kind="inet"):
                            if c.raddr:
                                conns.add(f"{c.raddr.ip}:{c.raddr.port} {c.status}")
                    except (psutil.Error, OSError):
                        pass
                    rss.append(p.memory_info().rss)
                t1 = p.cpu_times()
                c1 = p.num_ctx_switches()
                entry["cpu_s_60"] = round((t1.user + t1.system) - (t0.user + t0.system), 3)
                entry["ctx_switches_60"] = (c1.voluntary - c0.voluntary) + (c1.involuntary - c0.involuntary)
                entry["threads_end"] = p.num_threads()
                entry["rss_mb_end"] = round(rss[-1] / 1048576, 1)
                entry["rss_mb_drift"] = round((rss[-1] - rss[0]) / 1048576, 1)
                entry["remote_sockets"] = sorted(conns)
                entry["windows"] = [w[4] for w in visible_windows(proc.pid)]
            except psutil.Error as error:
                entry["error"] = str(error)
            entry["notes_log"] = tail(proc, 12, grep=["meeting", "Meeting", "calendar", "Calendar", "capabilit", "model", "speaker", "diariz", "transcri"])
            entry["log_lines"] = len(text(proc).splitlines())
            if rnd == 0:
                entry["shot"] = screenshot(f"idle60-{side}")
            kill(proc)
            record("idle60", side, entry)
            log("idle60", side, rnd, entry.get("cpu_s_60"), entry.get("ctx_switches_60"), entry.get("threads_end"), entry.get("remote_sockets"))


def flow_perf():
    """Same-machine A/B, sides rotated every round."""
    rounds = int(os.environ.get("GATE_PERF_ROUNDS", "3"))
    cases = [("studio30", "studio", 30, False), ("studio60", "studio", 60, False), ("instant60", "instant", 60, OS != "Windows")]
    for rnd in range(rounds):
        order = SIDES[rnd % len(SIDES):] + SIDES[: rnd % len(SIDES)]
        for label, mode, fps, mic in cases:
            for side in order:
                sb, entry = perf_record(side, label, mode, fps, 30, mic)
                entry["round"] = rnd
                if mode == "studio" and fps == 60 and entry.get("project"):
                    entry["playback"] = perf_playback(side, sb, Path(entry["project"]))
                record("perf", side, entry)
                rr = entry.get("recording_resources") or {}
                log("perf", label, side, rnd, rr.get("cpu_mean_pct"), rr.get("rss_mean_mb"), entry.get("stop_to_complete_s") or entry.get("stop_to_verified_s"))


def rms_per_second(path):
    """dBFS per whole second of the first audio stream (mono 16 kHz decode)."""
    import array
    import math

    try:
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
            capture_output=True,
            timeout=120,
        ).stdout
    except Exception:  # noqa: BLE001
        return []
    a = array.array("h")
    a.frombytes(raw[: len(raw) // 2 * 2])
    out = []
    for i in range(0, len(a) - 15999, 16000):
        chunk = a[i : i + 16000]
        ms = sum(x * x for x in chunk) / len(chunk)
        out.append(round(10 * math.log10(ms / (32768.0**2)) if ms > 0 else -120.0, 1))
    return out


def mic_sources(project):
    """(label, playable path) of each microphone track, fragmented ones joined."""
    found = []
    content = project / "content"
    for p in sorted(content.rglob("*")):
        low = str(p.relative_to(project)).lower()
        if not ("audio-input" in low or "mic" in low or p.name == "output.mp4"):
            continue
        if p.is_file() and p.suffix in (".ogg", ".m4a", ".mp4") and not p.name.startswith("init"):
            found.append((str(p.relative_to(project)), p))
        elif p.is_dir() and (p / "init.mp4").exists():
            segs = sorted(p.glob("segment_*.m4s"))
            if segs:
                dest = WORK / f"mic-{abs(hash(str(p)))}.mp4"
                concat([p / "init.mp4"] + segs, dest)
                found.append((str(p.relative_to(project)) + "/(joined)", dest))
    for p in sorted(project.glob("*.mp4")):
        found.append((p.name, p))
    return found[:4]


def shell(cmd):
    if not cmd:
        return None
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
    return {"rc": r.returncode, "out": (r.stdout + r.stderr)[-300:]}


def flow_devices():
    """Mic (and camera) unplugged 20 s into a 60 s recording, back at 30 s.
    Env: DEV_MIC (input name), DEV_MIC_UNPLUG / DEV_MIC_REPLUG (shell),
    DEV_CAM_ID / DEV_CAM_UNPLUG / DEV_CAM_REPLUG, DEV_STIM (shell, starts a
    tone into the mic for ~90 s), DEV_ROUNDS."""
    mic = os.environ.get("DEV_MIC")
    cam = os.environ.get("DEV_CAM_ID")
    rounds = int(os.environ.get("DEV_ROUNDS", "1"))
    for rnd in range(rounds):
        order = SIDES[rnd % len(SIDES):] + SIDES[: rnd % len(SIDES)]
        for mode in ("studio", "instant"):
            for kind in [k for k, on in (("mic", mic), ("camera", cam)) if on]:
                for side in order:
                    rs = {}
                    if mic:
                        rs["micName"] = mic
                    if (kind == "camera" or os.environ.get("DEV_CAM_ALWAYS")) and cam != "auto":
                        rs["cameraId"] = {"DeviceID": cam}
                    server = Mock(f"dev-{kind}-{mode}-{side}-{rnd}") if mode == "instant" else None
                    sb = Sandbox(f"dev-{kind}-{mode}-{side}-{rnd}", server=server.url if server else None, store={"recording_settings": rs})
                    env = {} if OS != "Linux" else {"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": "xmessage"}
                    env["CAP_GPUI_AUTO_RECORD"] = f"{mode}:60"
                    if kind == "camera" and cam == "auto":
                        env["CAP_GPUI_AUTO_CAMERA"] = "1"
                    if not mic:
                        env["CAP_GPUI_AUTO_NO_MIC"] = "1"
                    env["RUST_LOG"] = "cap_gpui=info,cap_desktop_gpui=info,cap_recording=info,cap_camera=info,cap_editor=info"
                    stim = subprocess.Popen(os.environ["DEV_STIM"], shell=True) if os.environ.get("DEV_STIM") else None
                    proc = sb.launch(side, f"dev-{kind}-{mode}", env)
                    entry = {"kind": kind, "mode": mode, "round": rnd}
                    t_start = wait_log(proc, "auto-record start requested", 90)
                    entry["started"] = t_start is not None
                    if t_start:
                        time.sleep(max(0, t_start + 20 - time.monotonic()))
                        entry["unplug"] = shell(os.environ.get("DEV_MIC_UNPLUG" if kind == "mic" else "DEV_CAM_UNPLUG"))
                        time.sleep(4)
                        if rnd == 0:
                            entry["shot_unplugged"] = screenshot(f"dev-{kind}-{mode}-unplugged-{side}")
                        time.sleep(max(0, t_start + 30 - time.monotonic()))
                        entry["replug"] = shell(os.environ.get("DEV_MIC_REPLUG" if kind == "mic" else "DEV_CAM_REPLUG"))
                        time.sleep(6)
                        if rnd == 0:
                            entry["shot_replugged"] = screenshot(f"dev-{kind}-{mode}-replugged-{side}")
                        t_stop = wait_log(proc, "auto-record stop requested", 60)
                        entry["stop_seen"] = t_stop is not None
                        if mode == "studio":
                            done = wait_finalized(sb, 120)
                            entry["stop_to_complete_s"] = round(done - t_stop, 2) if (done and t_stop) else None
                        else:
                            time.sleep(20)
                    entry["device_log"] = tail(proc, 14, grep=["disconnect", "reconnect", "unplug", "gone", "lost", "fallback", "replacement", "switch", "Disconnected", "Reconnected"])
                    entry["log_errors"] = tail(proc, 12, grep=["ERROR", "panicked"])
                    kill(proc)
                    if stim:
                        kill(stim)
                    shell(os.environ.get("DEV_MIC_REPLUG" if kind == "mic" else "DEV_CAM_REPLUG"))
                    if server:
                        server.finish()
                    projects = sb.projects()
                    if projects:
                        entry["status"] = meta_status(projects[0])
                        media = local_media(projects[0])
                        entry["media"] = {k: {"duration": v.get("duration"), "streams": [(s.get("codec_type"), s.get("duration"), s.get("nb_frames")) for s in v.get("streams", [])], "decodes": (v.get("decodes") or {}).get("ok")} for k, v in media.items()}
                        for p in mic_sources(projects[0]):
                            entry.setdefault("rms_db", {})[p[0]] = rms_per_second(p[1])
                    record("devices", side, entry)
                    log("devices", kind, mode, side, rnd, entry.get("status"))


def main():
    build_helpers()
    flows = {
        "startup": flow_startup,
        "instances": flow_instances,
        "instant": flow_instant,
        "studio": flow_studio,
        "recovery": flow_recovery,
        "ui": flow_ui,
        "automations": flow_automations,
        "barmenu": flow_barmenu,
        "automations_native": flow_automations_native,
        "hotkeys": flow_hotkeys,
        "targets": flow_targets,
        "export4k": flow_export4k,
        "ux": flow_ux,
        "editor_ux": flow_editor_ux,
        "perf": flow_perf,
        "devices": flow_devices,
        "playab": flow_playab,
        "memmap": flow_memmap,
        "exportab": flow_exportab,
        "idle60": flow_idle60,
    }
    for name, fn in flows.items():
        if "all" not in FLOWS and name not in FLOWS:
            continue
        log("== flow", name)
        try:
            fn()
        except Exception as error:  # noqa: BLE001
            import traceback

            RESULTS.setdefault("errors", []).append({"flow": name, "error": traceback.format_exc()})
            log("flow failed", name, error)
        save()
    for proc in psutil.process_iter(["name"]):
        if (proc.info["name"] or "").startswith("cap-gpui"):
            try:
                proc.kill()
            except psutil.Error:
                pass
    save()


if __name__ == "__main__":
    main()
