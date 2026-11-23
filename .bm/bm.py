#!/usr/bin/env python3
"""Upgrade-path regression driver for a released Cap and two builds.

flow: a released build makes a profile the way a user would (settings,
Studio, Instant, screenshot, an edit, an export), then each build opens a
copy of it as an in-place upgrade. Every run is a real app process with a
scratch data dir. Results go to <out>/summary.json and <out>/summary.md.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

import psutil

if os.name == "nt":
    OS = "windows"
elif sys.platform == "darwin":
    OS = "macos"
else:
    OS = "linux"

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def now():
    return time.monotonic()


class App:
    def __init__(self, binary, profile, out, name, env=None, libs=None):
        self.binary = binary
        self.profile = profile
        self.dir = os.path.join(out, "runs", name)
        self.name = name
        os.makedirs(self.dir, exist_ok=True)
        os.makedirs(os.path.join(self.dir, "logs"), exist_ok=True)
        self.env = dict(os.environ)
        self.env.update(
            {
                "CAP_GPUI_APP_DATA_DIR": profile,
                "CAP_GPUI_LOG_DIR": os.path.join(self.dir, "logs"),
                "RUST_LOG": "info",
                "NO_COLOR": "1",
            }
        )
        if OS == "linux":
            self.env["CAP_GPUI_NO_TRAY"] = "1"
        if libs:
            key = {"linux": "LD_LIBRARY_PATH", "macos": "DYLD_FALLBACK_LIBRARY_PATH"}.get(OS)
            if key:
                self.env[key] = libs + os.pathsep + self.env.get(key, "")
        self.env.update(env or {})
        self.lines = []
        self.lock = threading.Lock()
        self.samples = []
        self.remotes = set()
        self.proc = None
        self.started = None

    def start(self):
        self.log = open(os.path.join(self.dir, "app.log"), "w", encoding="utf-8", errors="replace")
        kwargs = {}
        if OS == "windows":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        self.started = now()
        self.proc = subprocess.Popen(
            [self.binary],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            cwd=self.dir,
            **kwargs,
        )
        self.ps = psutil.Process(self.proc.pid)
        threading.Thread(target=self._read, daemon=True).start()
        self.sampling = True
        threading.Thread(target=self._sample, daemon=True).start()
        return self

    def _read(self):
        for raw in iter(self.proc.stdout.readline, b""):
            line = ANSI.sub("", raw.decode("utf-8", "replace")).rstrip("\n")
            t = now() - self.started
            with self.lock:
                self.lines.append((t, line))
            self.log.write(f"[{t:8.3f}] {line}\n")
            self.log.flush()

    def _procs(self):
        procs = [self.ps]
        try:
            procs += self.ps.children(recursive=True)
        except psutil.Error:
            pass
        return procs

    def _sample(self):
        while self.sampling and self.proc.poll() is None:
            cpu = rss = threads = 0.0
            for p in self._procs():
                try:
                    c = p.cpu_times()
                    cpu += c.user + c.system
                    rss += p.memory_info().rss
                    threads += p.num_threads()
                    conns = p.net_connections(kind="inet") if hasattr(p, "net_connections") else p.connections(kind="inet")
                    for conn in conns:
                        if conn.raddr:
                            self.remotes.add(f"{conn.raddr.ip}:{conn.raddr.port}")
                except psutil.Error:
                    pass
            self.samples.append((now() - self.started, cpu, rss, threads))
            time.sleep(0.5)

    def text(self):
        with self.lock:
            return "\n".join(line for _, line in self.lines)

    def first(self, pattern):
        rx = re.compile(pattern)
        with self.lock:
            for t, line in self.lines:
                if rx.search(line):
                    return t
        return None

    def wait_log(self, pattern, timeout):
        end = now() + timeout
        while now() < end:
            t = self.first(pattern)
            if t is not None:
                return t
            if self.proc.poll() is not None:
                return self.first(pattern)
            time.sleep(0.2)
        return None

    def wait_glob(self, pattern, timeout, stable=1.5):
        end = now() + timeout
        last = None
        while now() < end:
            hits = sorted(glob.glob(pattern, recursive=True))
            if hits:
                size = os.path.getsize(hits[0])
                if last == size and size > 0:
                    return hits[0]
                last = size
                time.sleep(stable)
                continue
            if self.proc.poll() is not None:
                break
            time.sleep(0.3)
        hits = sorted(glob.glob(pattern, recursive=True))
        return hits[0] if hits else None

    def idle(self, seconds):
        time.sleep(seconds)

    def cpu_between(self, t0, t1):
        a = [s for s in self.samples if s[0] >= t0]
        b = [s for s in self.samples if s[0] <= t1]
        if not a or not b:
            return None
        return round(b[-1][1] - a[0][1], 3)

    def rss_at_end(self):
        return round(self.samples[-1][2] / 1e6, 1) if self.samples else None

    def threads_at_end(self):
        return int(self.samples[-1][3]) if self.samples else None

    def stop(self):
        self.sampling = False
        alive = self.proc.poll() is None
        if alive:
            procs = self._procs()
            try:
                if OS == "windows":
                    subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T"], capture_output=True)
                else:
                    self.proc.terminate()
                self.proc.wait(timeout=10)
            except Exception:
                pass
            for p in procs:
                try:
                    p.kill()
                except psutil.Error:
                    pass
            try:
                self.proc.wait(timeout=10)
            except Exception:
                pass
        time.sleep(0.5)
        self.log.close()
        text = self.text()
        res = {
            "alive_at_stop": alive,
            "exit": self.proc.returncode,
            "panics": text.count("panicked at"),
            "errors": len([l for l in text.splitlines() if " ERROR " in l or "ERROR " in l[:40]]),
            "remotes": sorted(self.remotes),
            "launch_error": [l for l in text.splitlines()
                             if re.search(r"Library not loaded|error while loading shared|cannot open shared object|was not found|0xc0000135", l)][:3],
        }
        with open(os.path.join(self.dir, "result.json"), "w") as f:
            json.dump(res, f, indent=1)
        return res


def screenshot(path, window_number=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        if OS == "macos":
            cmd = ["screencapture", "-x", "-o"]
            if window_number:
                cmd.append(f"-l{window_number}")
            subprocess.run(cmd + [path], timeout=20, capture_output=True)
        elif OS == "linux":
            subprocess.run(["import", "-window", "root", path], timeout=20, capture_output=True)
        else:
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
                "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;"
                "$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
                "$g=[System.Drawing.Graphics]::FromImage($i);"
                "$g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size);"
                f"$i.Save('{path}',[System.Drawing.Imaging.ImageFormat]::Png)"
            )
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], timeout=30, capture_output=True)
    except Exception as e:
        print("screenshot failed", e)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def snapshot(profile):
    files = {}
    for root, _, names in os.walk(profile):
        for n in names:
            p = os.path.join(root, n)
            rel = os.path.relpath(p, profile).replace("\\", "/")
            try:
                files[rel] = {"size": os.path.getsize(p), "sha": sha(p)}
            except OSError:
                pass
    store = None
    sp = os.path.join(profile, "store")
    if os.path.exists(sp):
        try:
            store = json.load(open(sp, encoding="utf-8"))
        except Exception as e:
            store = {"_unreadable": str(e)}
    return {"files": files, "store": store}


def flat(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flat(v, f"{prefix}{k}."))
    else:
        out[prefix[:-1]] = obj
    return out


def diff_snap(a, b):
    fa, fb = a["files"], b["files"]
    added = sorted(set(fb) - set(fa))
    removed = sorted(set(fa) - set(fb))
    changed = sorted(k for k in set(fa) & set(fb) if fa[k]["sha"] != fb[k]["sha"])
    sa, sb = flat(a["store"] or {}), flat(b["store"] or {})
    store_added = {k: sb[k] for k in sorted(set(sb) - set(sa))}
    store_removed = {k: sa[k] for k in sorted(set(sa) - set(sb))}
    store_changed = {k: [sa[k], sb[k]] for k in sorted(set(sa) & set(sb)) if sa[k] != sb[k]}
    return {
        "files_added": added,
        "files_removed": removed,
        "files_changed": changed,
        "store_added": store_added,
        "store_removed": store_removed,
        "store_changed": store_changed,
    }


def mp4_info(path):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,nb_frames,avg_frame_rate",
             "-of", "json", path],
            capture_output=True, text=True, timeout=60)
        return json.loads(r.stdout)
    except Exception as e:
        return {"error": str(e)}


def framemd5(path):
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-"],
                           capture_output=True, text=True, timeout=600)
        lines = [l.split(",")[-1].strip() for l in r.stdout.splitlines() if l and not l.startswith("#")]
        return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:16], len(lines)
    except Exception as e:
        return str(e), 0


def projects(profile):
    rec = os.path.join(profile, "recordings")
    out = []
    for p in sorted(glob.glob(os.path.join(rec, "*.cap"))):
        meta = {}
        try:
            meta = json.load(open(os.path.join(p, "recording-meta.json"), encoding="utf-8"))
        except Exception:
            pass
        kind = "instant" if "instant" in json.dumps(meta).lower()[:4000] and "segments" not in json.dumps(meta) else "studio"
        out.append({"path": p, "name": os.path.basename(p), "kind": kind, "meta_keys": sorted(meta)[:20]})
    return out


def screenshots_of(profile):
    return sorted(glob.glob(os.path.join(profile, "screenshots", "*.cap")))


class Flow:
    def __init__(self, args):
        self.a = args
        self.out = os.path.abspath(args.out)
        os.makedirs(self.out, exist_ok=True)
        self.summary = {"os": OS, "steps": {}}
        self.bins = {"old": args.old, "base": args.base, "head": args.head, "fix": args.fix}
        self.libs = {"old": args.old_libs, "base": args.base_libs, "head": args.head_libs, "fix": args.fix_libs}

    def ensure_target_window(self):
        if getattr(self, "_target", None) and self._target.poll() is None:
            return
        self._target = subprocess.Popen(
            ["xmessage", "-geometry", "480x270+700+300", "-title", "BM window to record",
             "A window to record, with some text in it."],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)

    def profile(self, name):
        p = os.path.join(self.out, "profiles", name)
        os.makedirs(p, exist_ok=True)
        return p

    def app(self, tag, profile, name, env=None):
        base_env = {"CAP_GPUI_AUTO_NO_MIC": "1"}
        if OS == "linux" and env and "CAP_GPUI_AUTO_RECORD" in env and env["CAP_GPUI_AUTO_RECORD"] != "screenshot":
            self.ensure_target_window()
            base_env.update({"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": "BM window to record"})
        base_env.update(env or {})
        return App(self.bins[tag], profile, self.out, name, base_env, self.libs[tag]).start()

    def record(self, key, value):
        print(f"== {key}: {json.dumps(value)[:600]}", flush=True)
        self.summary["steps"][key] = value
        self.save()

    def save(self):
        with open(os.path.join(self.out, "summary.json"), "w") as f:
            json.dump(self.summary, f, indent=1, default=str)

    # -- making the old profile -------------------------------------------
    def seed_store(self, profile, theme="dark"):
        store = {
            "general_settings": {
                "hasCompletedStartup": True,
                "hasCompletedOnboarding": True,
                "enableNotifications": False,
                "enableTelemetry": False,
                "recordingCountdown": 0,
                "theme": theme,
                "maxFps": 30,
                "autoZoomOnClicks": True,
                "transcriptionHints": ["Cap", "Acme Widgets", "Kubernetes"],
            },
            "recording_start_safety": {"confirmBeforeRecordingWithoutMicrophone": False},
            "presets": {"presets": [{"name": "BM preset", "config": {}}], "default": 0},
        }
        if self.a.server:
            store["general_settings"]["serverUrl"] = self.a.server
            store["auth"] = {
                "secret": {"api_key": self.a.api_key},
                "user_id": self.a.user_id,
                "plan": {"upgraded": False, "manual": False, "last_checked": int(time.time())},
                "organizations": [],
            }
        with open(os.path.join(profile, "store"), "w") as f:
            json.dump(store, f)

    def plain(self, tag, profile, name, idle=10, shots=(), env=None):
        app = self.app(tag, profile, name, env)
        t_open = app.wait_log(r"main window opened", 60)
        win = None
        if t_open is not None:
            m = re.search(r"number=(?:Some\()?(\d+)", app.text())
            win = m.group(1) if m else None
        for s in shots:
            time.sleep(s)
            screenshot(os.path.join(app.dir, f"shot-{s}.png"))
        app.idle(idle)
        t_end = now() - app.started
        res = app.stop()
        res.update({"launch_s": None if t_open is None else round(t_open, 3)})
        if t_open is not None:
            res["idle_cpu_s"] = app.cpu_between(t_open + 3, t_end)
        res["rss_mb"] = app.rss_at_end()
        res["threads"] = app.threads_at_end()
        res["window"] = win
        return res

    def studio(self, tag, profile, name, secs=6, env=None):
        before = set(p["path"] for p in projects(profile))
        app = self.app(tag, profile, name, dict({"CAP_GPUI_AUTO_RECORD": f"studio:{secs}"}, **(env or {})))
        started = app.wait_log(r"recording started", 60)
        finished = app.wait_log(r"recording finished", 60 + secs)
        app.idle(6)
        screenshot(os.path.join(app.dir, "after.png"))
        res = app.stop()
        new = [p for p in projects(profile) if p["path"] not in before]
        video = None
        if new:
            hits = glob.glob(os.path.join(new[0]["path"], "**", "display.mp4"), recursive=True)
            video = hits[0] if hits else None
        res.update({
            "started": started is not None,
            "finished": finished is not None,
            "project": new[0]["name"] if new else None,
            "display": mp4_info(video) if video else None,
        })
        return res, (new[0]["path"] if new else None)

    def instant(self, tag, profile, name, secs=5):
        before = set(p["path"] for p in projects(profile))
        app = self.app(tag, profile, name, {"CAP_GPUI_AUTO_RECORD": f"instant:{secs}"})
        started = app.wait_log(r"recording started", 60)
        finished = app.wait_log(r"recording finished", 60 + secs)
        uploaded = None
        if self.a.server:
            uploaded = app.wait_log(r"(?i)upload (complete|completed|finished|succeeded)|recording-complete|uploaded", 90)
        app.idle(5)
        res = app.stop()
        new = [p for p in projects(profile) if p["path"] not in before]
        out = None
        if new:
            hits = glob.glob(os.path.join(new[0]["path"], "**", "*.mp4"), recursive=True)
            out = hits[0] if hits else None
        res.update({
            "started": started is not None,
            "finished": finished is not None,
            "upload_log": uploaded is not None,
            "project": new[0]["name"] if new else None,
            "output": mp4_info(out) if out else None,
            "upload_lines": [l for l in app.text().splitlines() if "upload" in l.lower()][-15:],
        })
        return res, (new[0]["path"] if new else None)

    def shot(self, tag, profile, name):
        before = set(screenshots_of(profile))
        app = self.app(tag, profile, name, {"CAP_GPUI_AUTO_RECORD": "screenshot"})
        png = app.wait_glob(os.path.join(profile, "screenshots", "*.cap", "original.png"), 40)
        app.idle(3)
        res = app.stop()
        new = [p for p in screenshots_of(profile) if p not in before]
        res.update({"png": bool(png), "project": os.path.basename(new[0]) if new else None})
        return res, (new[0] if new else None)

    def editor(self, tag, profile, name, project, export=None, play=False):
        env = {"CAP_GPUI_AUTO_EDITOR": project}
        if play:
            env["CAP_GPUI_AUTO_PLAY"] = "1"
        if export:
            env["CAP_GPUI_AUTO_EXPORT"] = export
        app = self.app(tag, profile, name, env)
        loaded = app.wait_log(r"editor timeline model", 90)
        res_extra = {"loaded": loaded is not None}
        if loaded is not None:
            m = re.search(r"rows=(\d+).*total=\"?([0-9.]+)", app.text())
            res_extra["timeline"] = m.groups() if m else None
        if export:
            done = app.wait_log(r"editor export completed|editor export failed", 900)
            res_extra["export_ok"] = done is not None and "editor export completed" in app.text()
            res_extra["export_s"] = None if done is None or loaded is None else round(done - loaded, 2)
        else:
            app.idle(8)
        screenshot(os.path.join(app.dir, "editor.png"))
        res = app.stop()
        res.update(res_extra)
        if export and os.path.exists(export):
            res["export_info"] = mp4_info(export)
            res["export_framemd5"], res["export_frames"] = framemd5(export)
            res["export_bytes"] = os.path.getsize(export)
        return res

    def edit_project(self, project):
        path = os.path.join(project, "project-config.json")
        if not os.path.exists(path):
            return "no project-config.json"
        cfg = json.load(open(path, encoding="utf-8"))
        bg = cfg.get("background")
        if isinstance(bg, dict):
            bg["padding"] = 12.0
            bg["rounding"] = 30.0
            bg["source"] = {"type": "color", "value": [40, 80, 200]}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        return "edited background"

    def tcc_since(self, since):
        if OS != "macos":
            return None
        r = subprocess.run(["log", "show", "--start", since, "--style", "compact", "--predicate",
                            'subsystem == "com.apple.TCC" OR process == "tccd"'],
                           capture_output=True, text=True, timeout=120)
        lines = [l for l in r.stdout.splitlines() if re.search(r"(?i)cap-gpui|/Cap\b|Cap\.app", l)]
        services = sorted(set(re.findall(r"kTCCService\w+", "\n".join(lines))))
        reqs = [l for l in lines if re.search(r"(?i)AUTHREQ|prompt|request", l)]
        return {"services": services, "request_lines": reqs[:40], "lines": len(lines)}

    # -- the flow -----------------------------------------------------------
    def run(self):
        exports = os.path.join(self.out, "exports")
        os.makedirs(exports, exist_ok=True)
        old = self.profile("old")
        self.seed_store(old)

        self.record("old.first_launch", self.plain("old", old, "old-first", idle=12, shots=(4,)))
        r, studio_old = self.studio("old", old, "old-studio")
        self.record("old.studio", r)
        r, instant_old = self.instant("old", old, "old-instant")
        self.record("old.instant", r)
        r, shot_old = self.shot("old", old, "old-shot")
        self.record("old.screenshot", r)
        if studio_old:
            self.record("old.editor_open", self.editor("old", old, "old-editor", studio_old, play=True))
            self.record("old.edit", self.edit_project(studio_old))
            self.record("old.export", self.editor("old", old, "old-export", studio_old,
                                                  export=os.path.join(exports, "old-old.mp4")))
        self.record("old.settings", self.plain("old", old, "old-settings", idle=6,
                                               env={"CAP_GPUI_AUTO_SETTINGS": "general"}, shots=(3,)))
        old_snap = snapshot(old)
        json.dump(old_snap, open(os.path.join(self.out, "snap-old.json"), "w"), indent=1)

        arm_profiles = {}
        for tag in ("base", "head"):
            p = os.path.join(self.out, "profiles", tag)
            shutil.copytree(old, p)
            arm_profiles[tag] = p
            since = time.strftime("%Y-%m-%d %H:%M:%S")
            first = self.plain(tag, p, f"{tag}-first", idle=45, shots=(5, 20))
            first["tcc"] = self.tcc_since(since)
            self.record(f"{tag}.first_launch", first)
            snap = snapshot(p)
            self.record(f"{tag}.first_launch_profile_diff", diff_snap(old_snap, snap))
            rel_studio = os.path.relpath(studio_old, old) if studio_old else None
            if rel_studio:
                sp = os.path.join(p, rel_studio)
                self.record(f"{tag}.old_project_play", self.editor(tag, p, f"{tag}-old-play", sp, play=True))
                self.record(f"{tag}.old_project_export",
                            self.editor(tag, p, f"{tag}-old-export", sp, export=os.path.join(exports, f"{tag}-old.mp4")))
            if shot_old:
                spath = os.path.join(p, os.path.relpath(shot_old, old))
                app = self.app(tag, p, f"{tag}-old-shot-editor", {
                    "CAP_GPUI_AUTO_SCREENSHOT_EDITOR": spath,
                    "CAP_GPUI_AUTO_SCREENSHOT_EXPORT": os.path.join(exports, f"{tag}-old-shot.png")})
                got = app.wait_glob(os.path.join(exports, f"{tag}-old-shot.png"), 60)
                screenshot(os.path.join(app.dir, "shot-editor.png"))
                res = app.stop()
                res["exported"] = bool(got)
                if got:
                    res["sha"] = sha(got)
                self.record(f"{tag}.old_screenshot_editor", res)
            r, studio_new = self.studio(tag, p, f"{tag}-studio")
            self.record(f"{tag}.studio", r)
            if studio_new:
                self.record(f"{tag}.new_project_export",
                            self.editor(tag, p, f"{tag}-new-export", studio_new,
                                        export=os.path.join(exports, f"{tag}-new.mp4")))
            r, _ = self.instant(tag, p, f"{tag}-instant")
            self.record(f"{tag}.instant", r)
            r, _ = self.shot(tag, p, f"{tag}-shot")
            self.record(f"{tag}.screenshot", r)
            self.record(f"{tag}.settings", self.plain(tag, p, f"{tag}-settings", idle=6,
                                                      env={"CAP_GPUI_AUTO_SETTINGS": "general"}, shots=(3,)))
            self.record(f"{tag}.profile_after", diff_snap(old_snap, snapshot(p)))
            self.record(f"{tag}.projects", [x["name"] for x in projects(p)])

        # Downgrade: the released build reopens the profile the new build used.
        head_p = arm_profiles["head"]
        before = snapshot(head_p)
        self.record("downgrade.first_launch", self.plain("old", head_p, "down-first", idle=15, shots=(5,)))
        self.record("downgrade.profile_diff", diff_snap(before, snapshot(head_p)))
        for proj in projects(head_p):
            if "old-" in proj["name"]:
                continue
        newest = [x["path"] for x in projects(head_p)]
        if newest:
            self.record("downgrade.open_head_project",
                        self.editor("old", head_p, "down-editor", newest[-1],
                                    export=os.path.join(exports, "down-headproj.mp4")))
        r, _ = self.studio("old", head_p, "down-studio", secs=4)
        self.record("downgrade.studio", r)
        self.record("downgrade.relaunch_head", self.plain("head", head_p, "down-head-again", idle=8))

        # Idle cost with Notes untouched, alternating builds, fresh upgraded copies.
        rounds = []
        for i in range(self.a.rounds):
            order = ("base", "head") if i % 2 == 0 else ("head", "base")
            for tag in order:
                p = os.path.join(self.out, "profiles", f"idle-{tag}-{i}")
                shutil.copytree(old, p)
                first = self.plain(tag, p, f"idle-{tag}-{i}-a", idle=self.a.idle)
                second = self.plain(tag, p, f"idle-{tag}-{i}-b", idle=self.a.idle)
                rounds.append({"round": i, "tag": tag,
                               "first": {k: first.get(k) for k in ("launch_s", "idle_cpu_s", "rss_mb", "threads", "remotes")},
                               "second": {k: second.get(k) for k in ("launch_s", "idle_cpu_s", "rss_mb", "threads", "remotes")}})
                shutil.rmtree(p, ignore_errors=True)
        self.record("idle_rounds", rounds)
        self.write_md()

    def pixels(self):
        """macOS: the same surfaces from base and head, light and dark, then
        a per-pixel comparison (needs Pillow)."""
        from PIL import Image, ImageChops

        shots = os.path.join(self.out, "pixels")
        os.makedirs(shots, exist_ok=True)
        fixture = None
        results = {}
        for theme in ("light", "dark"):
            for tag in ("base", "head"):
                p = os.path.join(self.out, "profiles", f"px-{theme}-{tag}")
                os.makedirs(p, exist_ok=True)
                self.seed_store(p, theme=theme)
                if fixture:
                    shutil.copytree(fixture, os.path.join(p, "recordings", os.path.basename(fixture)))
                surfaces = {}
                app = self.app(tag, p, f"px-{theme}-{tag}-main")
                app.wait_log(r"main window opened", 60)
                m = re.search(r"number=(?:Some\()?(\d+)", app.text())
                time.sleep(4)
                surfaces["main"] = os.path.join(shots, f"{theme}-{tag}-main.png")
                screenshot(surfaces["main"], m.group(1) if m else None)
                surfaces["main_screen"] = os.path.join(shots, f"{theme}-{tag}-main-screen.png")
                screenshot(surfaces["main_screen"])
                app.stop()
                app = self.app(tag, p, f"px-{theme}-{tag}-settings", {"CAP_GPUI_AUTO_SETTINGS": "general"})
                app.wait_log(r"main window opened", 60)
                time.sleep(5)
                surfaces["settings"] = os.path.join(shots, f"{theme}-{tag}-settings.png")
                screenshot(surfaces["settings"])
                app.stop()
                if not fixture:
                    r, proj = self.studio(tag, p, f"px-{theme}-{tag}-rec", secs=4)
                    if proj:
                        fixture = os.path.join(self.out, "px-fixture.cap")
                        shutil.copytree(proj, fixture)
                proj = os.path.join(p, "recordings", os.path.basename(fixture)) if fixture else None
                if proj and os.path.exists(proj):
                    app = self.app(tag, p, f"px-{theme}-{tag}-editor", {"CAP_GPUI_AUTO_EDITOR": proj})
                    app.wait_log(r"editor timeline model", 90)
                    time.sleep(6)
                    surfaces["editor"] = os.path.join(shots, f"{theme}-{tag}-editor.png")
                    screenshot(surfaces["editor"])
                    app.stop()
                app = self.app(tag, p, f"px-{theme}-{tag}-recording", {"CAP_GPUI_AUTO_RECORD": "studio:12"})
                app.wait_log(r"recording started", 60)
                time.sleep(4)
                surfaces["recording"] = os.path.join(shots, f"{theme}-{tag}-recording.png")
                screenshot(surfaces["recording"])
                app.wait_log(r"recording finished", 30)
                app.stop()
                results[f"{theme}-{tag}"] = surfaces
        cmp = {}
        for theme in ("light", "dark"):
            for surface in ("main", "main_screen", "settings", "editor", "recording"):
                a = results.get(f"{theme}-base", {}).get(surface)
                b = results.get(f"{theme}-head", {}).get(surface)
                if not (a and b and os.path.exists(a) and os.path.exists(b)):
                    cmp[f"{theme}.{surface}"] = "missing"
                    continue
                ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
                if ia.size != ib.size:
                    cmp[f"{theme}.{surface}"] = f"size {ia.size} vs {ib.size}"
                    continue
                d = ImageChops.difference(ia, ib)
                # The menu bar clock differs between any two captures.
                w, h = d.size
                d.paste((0, 0, 0), (0, 0, w, int(h * 0.03))) if surface != "main" else None
                box = d.getbbox()
                px = sum(1 for v in d.convert("L").getdata() if v > 8)
                d.point(lambda v: 255 if v > 8 else 0).save(a.replace("-base-", "-diff-"))
                cmp[f"{theme}.{surface}"] = {"pixels_over_8": px, "of": w * h, "bbox": box}
        self.record("pixels", cmp)

    def header(self):
        """Linux: press header controls by accessibility name in the real app,
        count presses to each destination, and record what opened."""
        here = os.path.dirname(os.path.abspath(__file__))
        a11y = os.path.join(here, "bm_a11y.py")
        seed = self.profile("hdr-seed")
        self.seed_store(seed)
        r, _ = self.shot("base", seed, "hdr-seed-shot")
        r2, _ = self.studio("base", seed, "hdr-seed-studio", secs=4)
        self.record("header.seed", {"screenshot": r.get("png"), "studio": r2.get("finished")})
        plans = {
            "base": (False, [["Recordings"], ["Screenshots"], ["Teleprompter"], ["Changelog"], ["Settings"]]),
            "head": (False, [["Library"], ["Library", "Screenshots"], ["Teleprompter"], ["Settings", "Changelog"], ["Notes"]]),
            "head-libwindow": (True, [["Library"], ["Library", "Screenshots"], ["Notes"], ["Teleprompter"]]),
        }
        results = {}
        for config, (libwin, seqs) in plans.items():
            tag = "base" if config == "base" else "head"
            for seq in seqs:
                key = f"{config}:" + ">".join(seq)
                name = "hdr-" + config + "-" + "-".join(s.lower() for s in seq)
                p = os.path.join(self.out, "profiles", name)
                shutil.copytree(seed, p)
                if libwin:
                    st = json.load(open(os.path.join(p, "store")))
                    st["general_settings"]["libraryWindow"] = True
                    json.dump(st, open(os.path.join(p, "store"), "w"))
                before = snapshot(p)
                app = self.app(tag, p, name)
                app.wait_log(r"main window opened", 60)
                time.sleep(3)
                if not results.get(f"{config}:tree"):
                    d = subprocess.run([sys.executable, a11y, "dump", str(app.proc.pid)], capture_output=True, text=True, timeout=60)
                    open(os.path.join(app.dir, "tree.txt"), "w").write(d.stdout + d.stderr)
                    results[f"{config}:tree"] = len(d.stdout.splitlines())
                presses = []
                for target in seq:
                    pr = subprocess.run([sys.executable, a11y, "press", str(app.proc.pid), f"^{re.escape(target)}$"],
                                        capture_output=True, text=True, timeout=60)
                    presses.append((pr.stdout + pr.stderr).strip().splitlines()[-1:] or ["?"])
                    time.sleep(3)
                screenshot(os.path.join(app.dir, "after.png"))
                wins = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(app.proc.pid)],
                                      capture_output=True, text=True).stdout.split()
                titles = []
                for w in wins:
                    t = subprocess.run(["xdotool", "getwindowname", w], capture_output=True, text=True).stdout.strip()
                    titles.append(t)
                res = app.stop()
                diff = diff_snap(before, snapshot(p))
                notes_files = [f for f in diff["files_added"] if re.match(r"(meetings|documents|models|transcription_models)/", f)]
                results[key] = {
                    "presses": [x[0] for x in presses],
                    "clicks": len(seq),
                    "windows": titles,
                    "panics": res["panics"],
                    "remotes": res["remotes"],
                    "notes_or_model_files": notes_files,
                    "store_changed": diff["store_added"] | diff["store_changed"],
                    "log": [l for l in app.text().splitlines()
                            if re.search(r"(?i)notes window|library|teleprompter|settings|changelog|download|permission|model", l)][-8:],
                }
                self.record(f"header.{key}", results[key])
        self.record("header.trees", {k: v for k, v in results.items() if k.endswith(":tree")})

    def captions(self):
        """Linux: one Studio project with a known spoken track, captions
        generated in the real editor by each build, words compared."""
        text = ("Hello, this is Mister Kapp from Capp Street. Kap said the cap fits. "
                "We record our demos with Cap every week.")
        p0 = self.profile("cap-src")
        self.seed_store(p0)
        store_path = os.path.join(p0, "store")
        store = json.load(open(store_path))
        store["gpui"] = {"selectedTranscriptionModel": "small", "selectedTranscriptionLanguage": "en"}
        json.dump(store, open(store_path, "w"))
        if self.a.fixture:
            proj = os.path.join(p0, "recordings", "fixture.cap")
            shutil.copytree(self.a.fixture, proj)
            self.record("captions.fixture_files", sorted(
                os.path.relpath(f, proj) for f in glob.glob(os.path.join(proj, "**", "*"), recursive=True)
                if os.path.isfile(f))[:60])
        else:
            r, proj = self.studio("base", p0, "cap-record", secs=14, env={"CAP_GPUI_AUTO_NO_MIC": "0"})
            self.record("captions.record", r)
            if not proj:
                return
        mics = [f for f in glob.glob(os.path.join(proj, "**", "*"), recursive=True)
                if re.search(r"(audio-input|system_audio|mic)[^/\\]*\.(m4a|ogg|mp3|wav|aac|opus|flac)$", f)]
        self.record("captions.mic_files", mics)
        wav = os.path.join(self.out, "speech.wav")
        subprocess.run(["espeak-ng", "-s", "150", "-w", wav, text], check=True)
        for mic in mics:
            info = mp4_info(mic)
            dur = float(info.get("format", {}).get("duration", 12))
            tmp = mic + ".new" + os.path.splitext(mic)[1]
            ext = os.path.splitext(mic)[1].lower()
            codec = {".m4a": "aac", ".aac": "aac", ".ogg": "libopus", ".opus": "libopus",
                     ".mp3": "libmp3lame", ".wav": "pcm_s16le", ".flac": "flac"}[ext]
            streams = [x for x in info.get("streams", []) if x.get("codec_type") == "audio"]
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav, "-af", f"apad,atrim=0:{dur}",
                            "-ar", "48000", "-ac", "1", "-c:a", codec, tmp], check=True)
            self.record(f"captions.replaced.{os.path.basename(mic)}", {"duration": dur, "codec": codec, "orig_streams": streams})
            os.replace(tmp, mic)
        dumps = {}
        for tag in ("base", "head", "fix"):
            if not self.bins.get(tag):
                continue
            p = self.profile(f"cap-{tag}")
            shutil.copy(store_path, os.path.join(p, "store"))
            dst = os.path.join(p, "recordings", os.path.basename(proj))
            shutil.copytree(proj, dst)
            dump = os.path.join(self.out, f"captions-{tag}.json")
            app = self.app(tag, p, f"cap-{tag}", {
                "CAP_GPUI_AUTO_EDITOR": dst,
                "CAP_GPUI_AUTO_SIDEBAR": "captions",
                "CAP_GPUI_AUTO_TRANSCRIPT": f"transcribe,dump:{dump}",
            })
            app.wait_log(r"transcribe finished", 600)
            app.wait_glob(dump, 60)
            res = app.stop()
            cfg = {}
            try:
                cfg = json.load(open(os.path.join(dst, "project-config.json")))
            except Exception:
                pass
            caps = cfg.get("captions") or {}
            seg_text = [s.get("text") for s in caps.get("segments", [])] if isinstance(caps, dict) else None
            words = []
            if os.path.exists(dump):
                words = [(w["text"], round(w["start"], 3), round(w["end"], 3)) for w in json.load(open(dump)).get("words", [])]
            dumps[tag] = {"words": words, "segments": seg_text,
                          "model_lines": [l for l in app.text().splitlines() if re.search(r"(?i)whisper|parakeet|model", l)][-6:],
                          "panics": res["panics"]}
        cmp = {}
        for a, b in (("base", "head"), ("base", "fix")):
            if a in dumps and b in dumps:
                cmp[f"{a}_vs_{b}"] = {
                    "words_identical": dumps[a]["words"] == dumps[b]["words"],
                    "segments_identical": dumps[a]["segments"] == dumps[b]["segments"],
                }
        self.record("captions.text", {k: " ".join(t for t, _, _ in v["words"]) for k, v in dumps.items()})
        self.record("captions.detail", dumps)
        self.record("captions.compare", cmp)

    def write_md(self):
        s = self.summary["steps"]
        lines = [f"# BM upgrade run on {OS}", ""]
        for k, v in s.items():
            lines.append(f"## {k}")
            lines.append("```")
            lines.append(json.dumps(v, indent=1, default=str)[:4000])
            lines.append("```")
        open(os.path.join(self.out, "summary.md"), "w").write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old")
    ap.add_argument("--base")
    ap.add_argument("--head")
    ap.add_argument("--old-libs")
    ap.add_argument("--base-libs")
    ap.add_argument("--head-libs")
    ap.add_argument("--fix")
    ap.add_argument("--fixture")
    ap.add_argument("--fix-libs")
    ap.add_argument("--out", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--idle", type=int, default=45)
    ap.add_argument("--server")
    ap.add_argument("--api-key")
    ap.add_argument("--user-id")
    ap.add_argument("--mode", default="flow")
    ap.add_argument("--tag")
    ap.add_argument("--name")
    args = ap.parse_args()
    flow = Flow(args)
    if args.mode == "header":
        try:
            flow.header()
        finally:
            flow.save()
        return
    if args.mode == "captions":
        try:
            flow.captions()
        finally:
            flow.save()
        return
    if args.mode == "pixels":
        try:
            flow.pixels()
        finally:
            flow.save()
        return
    if args.mode == "instant":
        p = flow.profile(args.name)
        flow.seed_store(p)
        r, proj = flow.instant(args.tag, p, args.name, secs=5)
        r["project_path"] = proj
        r["meta"] = None
        if proj and os.path.exists(os.path.join(proj, "recording-meta.json")):
            r["meta"] = json.load(open(os.path.join(proj, "recording-meta.json")))
        flow.record(f"instant.{args.name}", r)
        print(json.dumps(r, indent=1, default=str)[:6000])
        return
    try:
        flow.run()
    finally:
        flow.save()
        flow.write_md()


if __name__ == "__main__":
    main()
