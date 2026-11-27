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
SIDES = [s for s in ("v062", "base", "head") if (APPS / s / "bin").exists()]
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


def perf_record(side, label, mode, fps, secs, mic):
    sb = Sandbox(f"perf-{label}-{side}-{int(time.time())}", general={"maxFps": fps, "postStudioRecordingBehaviour": "showOverlay"})
    env = {} if OS != "Linux" else {"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": "xmessage"}
    if not mic:
        env["CAP_GPUI_AUTO_NO_MIC"] = "1"
    env["CAP_GPUI_AUTO_RECORD"] = f"{mode}:{secs}"
    server = None
    if mode == "instant":
        server = Mock(f"perf-{label}-{side}-{int(time.time())}")
        sb = Sandbox(f"perf-{label}-{side}-{int(time.time())}", server=server.url, general={"maxFps": fps})
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
    env = {"CAP_GPUI_AUTO_EDITOR": str(project), "CAP_GPUI_AUTO_PLAYBACK": "12", "CAP_GPUI_AUTO_FRAME_STATS": "10"}
    proc = sb.launch(side, "perf-play", env)
    entry = {}
    elapsed, _ = wait_window(proc, 90, min_size=400)
    entry["editor_window_s"] = round(elapsed, 3) if elapsed else None
    t_play = wait_log(proc, "auto playback: playing", 120)
    if t_play:
        with Sampler(proc.pid) as s:
            time.sleep(10)
        entry["playback_resources"] = s.summary()
        time.sleep(4)
    entry["frame_stats"] = tail(proc, 2, grep=["frame stats"])
    entry["log_errors"] = tail(proc, 6, grep=["ERROR", "panicked"])
    kill(proc)
    return entry


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
