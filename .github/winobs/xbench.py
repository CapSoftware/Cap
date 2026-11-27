#!/usr/bin/env python3
"""Cross-platform (Windows, Linux) Cap vs OBS bench driver. Mirrors bench/rig/bench.py on macOS.

xbench.py run --out DIR --recorder NAME=cap:/path/to/cap[;ENV=V...] --recorder obs=obs:matched
              --scenes still,scroll,motion --fps 60 --reps 3 [--duration 20] [--warmup 3] [--audio]
              [--machine win] [--keep] [--stress N] [--stress-at S] [--kill-at S]
xbench.py summary FILE...
Every run: stimulus up, settle 2 s, recorder records warmup+duration seconds, 1 Hz psutil sampling of
the recorder's process tree (+ nvidia-smi dmon), then analyze.py on the file (frames, pacing, bitrate,
encoder) and, with --audio, A/V sync of the beep against the frame it was played on.
"""
import argparse, base64, csv, glob, json, os, platform, random, re, shutil, signal, socket, statistics
import struct, subprocess, sys, threading, time, uuid

import psutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze as anz  # noqa: E402

WIN = sys.platform == "win32"
PY = sys.executable
STIM = os.path.join(HERE, "stim.py")
OBS_ROOT = os.environ.get("OBS_ROOT", r"C:\rig\obs" if WIN else "/usr")
OBS_HOME = os.environ.get("OBS_HOME", r"C:\rig\obs" if WIN else "/rig/obshome")
OBS_CFG = os.path.join(OBS_HOME, "config", "obs-studio") if WIN else os.path.join(OBS_HOME, ".config", "obs-studio")
OBS_PORT = 4466
CAP_LOG_LEVEL = os.environ.get("CAP_LOG_LEVEL", "info")
NV_ENCODER = os.environ.get("OBS_NV_ENCODER", "")
CAP_MODE = ["studio"]
CAP_WINDOW = [None]
CAP_DEFAULT_FPS = [False]


def now_ns():
    return time.perf_counter_ns()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sha16(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()[:16]


# ------------------------------------------------------------------ sampling

class Sampler(threading.Thread):
    def __init__(self, period=1.0):
        super().__init__(daemon=True)
        self.period = period
        self.root = None
        self.samples = []
        self.marks = {}
        self._halt = threading.Event()
        self.nv = None
        if shutil.which("nvidia-smi"):
            self.nv = subprocess.Popen(["nvidia-smi", "dmon", "-s", "u", "-d", "1"], stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True)
            self.nvrows = []
            threading.Thread(target=self._nvread, daemon=True).start()

    def _nvread(self):
        for line in self.nv.stdout:
            p = line.split()
            if p and p[0].isdigit() and len(p) >= 5:
                try:
                    self.nvrows.append((now_ns(), int(p[1]), int(p[3]) if p[3] != "-" else 0))
                except ValueError:
                    pass

    def set_root(self, pid):
        self.root = pid

    def mark(self, k):
        self.marks[k] = now_ns()

    def tree(self):
        try:
            p = psutil.Process(self.root)
            return [p] + p.children(recursive=True)
        except psutil.Error:
            return []

    def run(self):
        while not self._halt.is_set():
            t = now_ns()
            if self.root:
                cpu = 0.0
                priv = 0
                rss = 0
                thr = 0
                n = 0
                for p in self.tree():
                    try:
                        with p.oneshot():
                            ct = p.cpu_times()
                            cpu += ct.user + ct.system
                            mi = p.memory_info()
                            rss += mi.rss
                            if WIN:
                                priv += getattr(mi, "private", 0)
                            else:
                                try:
                                    priv += p.memory_full_info().uss
                                except psutil.Error:
                                    priv += mi.rss
                            thr += p.num_threads()
                            n += 1
                    except psutil.Error:
                        pass
                self.samples.append({"t": t, "cpu_s": cpu, "priv": priv, "rss": rss, "threads": thr, "procs": n,
                                     "sys_cpu": psutil.cpu_percent(None)})
            self._halt.wait(self.period)

    def stop(self):
        self._halt.set()
        self.join(timeout=5)
        if self.nv:
            self.nv.terminate()


def summarize(samples, t0, t1, nvrows=None):
    w = [s for s in samples if t0 <= s["t"] <= t1 and s["procs"] > 0]
    if len(w) < 2:
        return None
    cpu = (w[-1]["cpu_s"] - w[0]["cpu_s"]) / ((w[-1]["t"] - w[0]["t"]) / 1e9)
    half = w[len(w) // 2:]
    mb = [s["priv"] / 1048576 for s in w]
    xs = [(s["t"] - w[0]["t"]) / 6e10 for s in w]
    slope, _ = anz.linfit(xs, mb)
    out = {"cpu_s_per_s": round(cpu, 4), "mem_steady_mb": round(statistics.median(s["priv"] / 1048576 for s in half), 1),
           "mem_peak_mb": round(max(mb), 1), "rss_peak_mb": round(max(s["rss"] for s in w) / 1048576, 1),
           "mem_slope_mb_per_min": round(slope, 2) if slope is not None else None,
           "threads": max(s["threads"] for s in w), "sys_cpu_pct": round(statistics.median(s["sys_cpu"] for s in w), 1),
           "n": len(w)}
    if nvrows:
        nv = [r for r in nvrows if t0 <= r[0] <= t1]
        if nv:
            out["gpu_sm_pct"] = round(statistics.median(r[1] for r in nv), 1)
            out["gpu_enc_pct"] = round(statistics.median(r[2] for r in nv), 1)
    return out


# ------------------------------------------------------------------ stimulus

class Stimulus:
    def __init__(self, scene, out, beep=False, hz=None):
        os.makedirs(out, exist_ok=True)
        self.out = out
        self.stopf = os.path.join(out, "STOP")
        args = [PY, STIM, "--scene", scene, "--out", out, "--stop-file", self.stopf]
        if beep:
            args.append("--beep")
        if hz:
            args += ["--hz", str(hz)]
        self.p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if WIN:
            try:
                psutil.Process(self.p.pid).nice(psutil.HIGH_PRIORITY_CLASS)
            except psutil.Error:
                pass
        line = self.p.stdout.readline()
        if "stimulus ready" not in line:
            raise RuntimeError(f"stimulus failed: {line} {self.p.stdout.read()[-800:]}")
        self.info = json.load(open(os.path.join(out, "stimulus.json")))

    def stop(self):
        open(self.stopf, "w").close()
        try:
            self.p.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            self.p.kill()
        self.info = json.load(open(os.path.join(self.out, "stimulus.json")))


# ------------------------------------------------------------------ obs websocket (from bench.py)

class WS:
    def __init__(self, port, timeout=30):
        deadline = time.time() + timeout
        while True:
            try:
                self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n")
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        if b" 101 " not in buf.split(b"\r\n")[0]:
            raise RuntimeError(buf[:200])
        self.rest = buf.split(b"\r\n\r\n", 1)[1]
        self.recv()
        self.send({"op": 1, "d": {"rpcVersion": 1, "eventSubscriptions": 0}})
        if self.recv().get("op") != 2:
            raise RuntimeError("identify failed")

    def _read(self, n):
        while len(self.rest) < n:
            c = self.s.recv(65536)
            if not c:
                raise EOFError
            self.rest += c
        o, self.rest = self.rest[:n], self.rest[n:]
        return o

    def recv(self):
        while True:
            b1, b2 = self._read(2)
            op = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            data = self._read(n)
            if op == 1:
                return json.loads(data)
            if op == 9:
                self._frame(10, data)
            if op == 8:
                raise EOFError

    def _frame(self, op, data):
        mask = os.urandom(4)
        n = len(data)
        hdr = bytes([0x80 | op])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(hdr + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))

    def send(self, obj):
        self._frame(1, json.dumps(obj).encode())

    def req(self, rtype, data=None):
        rid = uuid.uuid4().hex
        self.send({"op": 6, "d": {"requestType": rtype, "requestId": rid, "requestData": data or {}}})
        while True:
            m = self.recv()
            if m.get("op") == 7 and m["d"].get("requestId") == rid:
                st = m["d"]["requestStatus"]
                if not st.get("result"):
                    raise RuntimeError(f"{rtype} failed: {st}")
                return m["d"].get("responseData") or {}

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def ini(sections):
    out = []
    for sec, kv in sections.items():
        out.append(f"[{sec}]")
        out += [f"{k}={v}" for k, v in kv.items()]
        out.append("")
    return "\n".join(out)


def obs_exe():
    if WIN:
        return os.path.join(OBS_ROOT, "bin", "64bit", "obs64.exe")
    return shutil.which("obs") or "/usr/bin/obs"


def obs_write_config(mode, stim, fps, rec_dir, audio, bitrate_kbps=None, keyint_s=1, bframes=False, encoder=None):
    prof_dir = os.path.join(OBS_CFG, "basic", "profiles", "rig")
    os.makedirs(prof_dir, exist_ok=True)
    os.makedirs(os.path.join(OBS_CFG, "basic", "scenes"), exist_ok=True)
    os.makedirs(os.path.join(OBS_CFG, "plugin_config", "obs-websocket"), exist_ok=True)
    general = {"Pre19Defaults": "false", "Pre21Defaults": "false", "Pre23Defaults": "false",
               "Pre24.1Defaults": "false", "FirstRun": "false", "LastVersion": str((33 << 24) | 3),
               "EnableAutoUpdates": "false", "ConfirmOnExit": "false", "InfoIncrement": "-1",
               "LicenseAccepted": "true"}
    basicwin = {"PreviewEnabled": "false", "WarnBeforeStartingRecord": "false", "WarnBeforeStoppingRecord": "false",
                "SysTrayEnabled": "false", "ShowWhatsNew": "false"}
    basic = {"Profile": "rig", "ProfileDir": "rig", "SceneCollection": "rig", "SceneCollectionFile": "rig",
             "ConfigOnNewProfile": "false"}
    for name in ("global.ini", "user.ini"):
        open(os.path.join(OBS_CFG, name), "w").write(ini({"General": general, "BasicWindow": basicwin, "Basic": basic}))
    w, h = int(stim["px_w"]), int(stim["px_h"])
    rec_dir = rec_dir.replace("\\", "/")
    prof = {"General": {"Name": "rig"},
            "Video": {"BaseCX": w, "BaseCY": h, "OutputCX": w, "OutputCY": h, "FPSType": 2, "FPSNum": fps,
                      "FPSDen": 1, "ScaleType": "bicubic", "ColorFormat": "NV12", "ColorSpace": "709",
                      "ColorRange": "Partial"},
            "Audio": {"SampleRate": 48000, "ChannelSetup": "Stereo"},
            "SimpleOutput": {"FilePath": rec_dir, "RecFormat2": "hybrid_mp4"},
            "AdvOut": {"RecFilePath": rec_dir}}
    if mode.startswith("matched"):
        prof["Output"] = {"Mode": "Advanced"}
        prof["AdvOut"].update({"RecType": "Standard", "RecFormat2": "hybrid_mp4", "RecEncoder": encoder,
                               "RecTracks": 3, "RecRescale": "false", "RecSplitFile": "false",
                               "RecAudioEncoder": "ffmpeg_aac"})
        enc = {"rate_control": "CBR", "bitrate": int(bitrate_kbps), "keyint_sec": keyint_s, "preset2": "p5",
               "tune": "hq", "multipass": "qres", "profile": "high", "bf": 2 if bframes else 0,
               "lookahead": False, "psycho_aq": True}
        json.dump(enc, open(os.path.join(prof_dir, "recordEncoder.json"), "w"))
    else:
        prof["Output"] = {"Mode": "Simple"}
        prof["SimpleOutput"].update({"RecQuality": "Stream", "RecEncoder": "x264"})
        p = os.path.join(prof_dir, "recordEncoder.json")
        if os.path.exists(p):
            os.remove(p)
    open(os.path.join(prof_dir, "basic.ini"), "w").write(ini(prof))
    scene_uuid, src_uuid = str(uuid.uuid4()), str(uuid.uuid4())
    if WIN:
        src = {"id": "monitor_capture", "versioned_id": "monitor_capture",
               "settings": {"method": 2 if mode.endswith("-wgc") else 0, "capture_cursor": False}}
    else:
        src = {"id": "xshm_input", "versioned_id": "xshm_input_v2", "settings": {"screen": 0, "show_cursor": False}}
    coll = {
        "name": "rig", "current_scene": "Scene", "current_program_scene": "Scene",
        "scene_order": [{"name": "Scene"}], "groups": [], "quick_transitions": [], "saved_projectors": [],
        "transitions": [], "current_transition": "Cut", "transition_duration": 0, "modules": {},
        "sources": [
            {"id": "scene", "versioned_id": "scene", "name": "Scene", "uuid": scene_uuid, "enabled": True,
             "mixers": 0, "settings": {"custom_size": False, "id_counter": 1, "items": [
                 {"name": "Display", "source_uuid": src_uuid, "visible": True, "locked": False, "id": 1,
                  "pos": {"x": 0.0, "y": 0.0}, "scale": {"x": 1.0, "y": 1.0}, "rot": 0.0, "align": 5,
                  "bounds_type": 0, "bounds_align": 0, "bounds": {"x": 0.0, "y": 0.0}}]}},
            dict(src, name="Display", uuid=src_uuid, enabled=True, mixers=0),
        ],
    }
    if audio:
        kind_out = "wasapi_output_capture" if WIN else "pulse_output_capture"
        kind_in = "wasapi_input_capture" if WIN else "pulse_input_capture"
        coll["DesktopAudioDevice1"] = {"id": kind_out, "versioned_id": kind_out, "name": "Desktop Audio",
                                       "uuid": str(uuid.uuid4()), "mixers": 1, "enabled": True,
                                       "settings": {"device_id": "default"}}
        coll["AuxAudioDevice1"] = {"id": kind_in, "versioned_id": kind_in, "name": "Mic/Aux",
                                   "uuid": str(uuid.uuid4()), "mixers": 2, "enabled": True,
                                   "settings": {"device_id": "default"}}
    json.dump(coll, open(os.path.join(OBS_CFG, "basic", "scenes", "rig.json"), "w"), indent=1)
    json.dump({"alerts_enabled": False, "auth_required": False, "first_load": False, "server_enabled": True,
               "server_password": "", "server_port": OBS_PORT},
              open(os.path.join(OBS_CFG, "plugin_config", "obs-websocket", "config.json"), "w"))


def obs_log_stats(text):
    out = {}
    for key, rx in (("frames_output", r"Total frames output:\s*(\d+)"),):
        m = re.search(rx, text)
        if m:
            out[key] = int(m.group(1))
    m = re.search(r"Total drawn frames:\s*(\d+)(?:\s*\((\d+) attempted\))?", text)
    if m:
        out["frames_drawn"] = int(m.group(1))
        if m.group(2):
            out["frames_attempted"] = int(m.group(2))
    m = re.search(r"Number of lagged frames due to rendering lag/stalls:\s*(\d+)\s*\(([\d.]+)%\)", text)
    if m:
        out["render_lagged"] = int(m.group(1))
    m = re.search(r"Number of skipped frames due to encoding lag:\s*(\d+)/(\d+)", text)
    if m:
        out["encode_skipped"] = int(m.group(1))
        out["encode_skipped_of"] = int(m.group(2))
    m = re.search(r"Video stopped, number of skipped frames due to encoding lag:\s*(\d+)/(\d+)", text)
    if m:
        out["video_skipped_encoding"] = int(m.group(1))
    enc = re.findall(r"\[(?:obs-nvenc|NVENC|jim-nvenc|nvenc)[^\]]*\][^\n]*", text, re.I)
    if enc:
        out["nvenc_log"] = [e.strip()[:200] for e in enc[:25]]
    m = re.search(r"Available Encoders:(.*?)(?:\n\s*\n|==== )", text, re.S)
    if m:
        out["available"] = m.group(1)[:1500]
    return out


def obs_pick_encoder():
    """Run OBS once to read its encoder list from the log; prefer NVENC texture/native encoders."""
    if NV_ENCODER:
        return NV_ENCODER
    p = os.path.join(OBS_CFG, "logs")
    texts = "".join(open(f, errors="replace").read() for f in sorted(glob.glob(os.path.join(p, "*.txt")))[-3:])
    for cand in ("obs_nvenc_h264_tex", "obs_nvenc_h264_cuda", "jim_nvenc", "ffmpeg_nvenc", "obs_qsv11_v2", "h264_texture_amf"):
        if re.search(r"\b" + cand + r"\b", texts):
            return cand
    return "obs_nvenc_h264_tex" if WIN else "obs_nvenc_h264_cuda"


def obs_env():
    env = dict(os.environ)
    if not WIN:
        env["XDG_CONFIG_HOME"] = os.path.join(OBS_HOME, ".config")
    return env


def run_obs(mode, stim, fps, total_s, run_dir, smpl, audio, bitrate_kbps=None, keyint_s=1, bframes=False,
            encoder=None, kill_at=None, pause=None, media_dir=None):
    rec_dir = os.path.join(media_dir, os.path.basename(run_dir)) if media_dir else os.path.join(run_dir, "obsrec")
    os.makedirs(rec_dir, exist_ok=True)
    obs_write_config(mode, stim, fps, rec_dir, audio, bitrate_kbps, keyint_s, bframes, encoder)
    logs_dir = os.path.join(OBS_CFG, "logs")
    before = set(glob.glob(os.path.join(logs_dir, "*.txt")))
    args = [obs_exe(), "--disable-updater", "--disable-missing-files-check", "--profile", "rig", "--collection",
            "rig", "--scene", "Scene", "--multi", "--disable-shutdown-check"]
    if WIN:
        args.append("--portable")
    cwd = os.path.dirname(obs_exe())
    t_launch = now_ns()
    outf = open(os.path.join(run_dir, "obs.stdout.log"), "w")
    p = subprocess.Popen(args, stdout=outf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=obs_env(), cwd=cwd)
    smpl.set_root(p.pid)
    ws = None
    media = None
    killed = False
    stop_req = None
    started = None
    t_end = None
    try:
        ws = WS(OBS_PORT, timeout=90)
        deadline = time.time() + 90
        while True:
            try:
                vs = ws.req("GetVideoSettings")
                break
            except RuntimeError as e:
                if "207" not in str(e) or time.time() > deadline:
                    raise
                time.sleep(0.5)
        if WIN:
            items = ws.req("GetInputPropertiesListPropertyItems", {"inputName": "Display", "propertyName": "monitor_id"})
            mon = [i for i in items.get("propertyItems", []) if i.get("itemEnabled", True)]
            if mon:
                ws.req("SetInputSettings", {"inputName": "Display", "inputSettings": {"monitor_id": mon[0]["itemValue"]}})
        inp = ws.req("GetInputSettings", {"inputName": "Display"})
        if not WIN:
            for _ in range(2):
                subprocess.run("for w in $(xdotool search --name '^OBS '); do xdotool windowminimize $w; done; "
                               "for w in $(xdotool search --name obsbench-stimulus); do xdotool windowactivate $w; done",
                               shell=True, capture_output=True, timeout=20)
                time.sleep(0.7)
        time.sleep(2.0)
        t_req = now_ns()
        ws.req("StartRecord")
        dl = time.time() + 15
        while not ws.req("GetRecordStatus").get("outputActive"):
            if time.time() > dl:
                raise RuntimeError("OBS recording did not become active")
            time.sleep(0.02)
        started = now_ns()
        smpl.mark("rec_start")
        if pause:
            at, ln = (float(x) for x in pause.split(":"))
            time.sleep(at)
            ws.req("PauseRecord")
            smpl.mark("pause")
            time.sleep(ln)
            ws.req("ResumeRecord")
            smpl.mark("resume")
        if kill_at:
            time.sleep(kill_at)
            stop_req = now_ns()
            p.kill()
            killed = True
            p.wait()
            t_end = now_ns()
        else:
            time.sleep(max(0.0, total_s - (now_ns() - started) / 1e9))
            stop_req = now_ns()
            res = ws.req("StopRecord")
            dl2 = time.time() + 120
            while ws.req("GetRecordStatus").get("outputActive") and time.time() < dl2:
                time.sleep(0.01)
            t_end = now_ns()
            media = res.get("outputPath")
        smpl.mark("rec_end")
        time.sleep(1.0)
    finally:
        if ws:
            ws.close()
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=30)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        outf.close()
        new_logs = sorted(set(glob.glob(os.path.join(logs_dir, "*.txt"))) - before)
        text = "".join(open(f, errors="replace").read() for f in new_logs)
        open(os.path.join(run_dir, "obs.log"), "w").write(text)
    if killed:
        files = sorted(glob.glob(os.path.join(rec_dir, "*")))
        media = files[-1] if files else None
    return {"media": media, "t_launch": t_launch, "t_start": started, "t_stop": t_end, "rec_stop_requested": stop_req,
            "startup_ms": round((started - t_req) / 1e6, 1), "finalize_ms": round((t_end - stop_req) / 1e6, 1),
            "obs_effective": {"video": vs, "input": inp.get("inputSettings"), "encoder": encoder},
            "obs_log": obs_log_stats(text), "obs_exit": p.returncode, "killed": killed}


# ------------------------------------------------------------------ cap

def parse_cap_arg(arg):
    parts = arg.split(";")
    env = {}
    for kv in parts[1:]:
        k, _, v = kv.partition("=")
        env[k] = v
    return parts[0], env


def cap_window_id(binary, env, title):
    out = subprocess.run([binary, "targets", "windows", "--format", "json"], capture_output=True, text=True, env=env,
                         timeout=60).stdout
    try:
        arr = json.loads(out)
    except ValueError:
        arr = json.loads(out[out.index("["):])
    for w in arr:
        if any(isinstance(v, str) and title in v for v in w.values()):
            return str(w["id"])
    raise RuntimeError(f"window {title!r} not found in {out[:600]}")


def cap_screen_id(binary, env):
    out = subprocess.run([binary, "targets", "screens", "--format", "json"], capture_output=True, text=True, env=env,
                         timeout=60).stdout
    try:
        arr = json.loads(out)
    except ValueError:
        arr = json.loads(out[out.index("["):])
    prim = [s for s in arr if s.get("primary")] or arr
    return str(prim[0]["id"])


def cap_log_facts(path):
    text = re.sub(r"\x1b\[[0-9;]*m", "", open(path, errors="replace").read())
    rx = re.compile(r"encoder|nvenc|libx264|h264_mf|mediafoundation|drop|stall|skipp|behind|lagg|queue full|"
                    r"timed out|overrun|lost|gap|panic|error", re.I)
    lines = [l for l in text.splitlines() if rx.search(l)]
    levels = {}
    for l in text.splitlines():
        m = re.search(r"\b(TRACE|DEBUG|INFO|WARN|ERROR)\b", l)
        if m:
            levels[m.group(1)] = levels.get(m.group(1), 0) + 1
    enc = None
    for name in ("h264_nvenc", "h264_mf", "h264_qsv", "h264_amf", "h264_vaapi", "libx264"):
        if name in text:
            enc = name
            break
    return {"encoder_from_log": enc, "levels": levels, "lines": [l[:400] for l in lines[:80]]}


def run_cap(arg, stim, fps, total_s, run_dir, smpl, home, audio, mic=None, kill_at=None, media_dir=None):
    binary, extra = parse_cap_arg(arg)
    extra = {k: v.replace("{run}", run_dir) for k, v in extra.items()}
    if "CAP_WIN_FRAME_TRACE" in extra and stim and stim.get("code"):
        c = stim["code"]
        extra.setdefault("CAP_WIN_FRAME_TRACE_CODE", f"{int(c['cell'])},{int(c['x'])},{int(c['y'])}")
    env = dict(os.environ, **extra)
    os.makedirs(home, exist_ok=True)
    if WIN:
        env.update({"APPDATA": os.path.join(home, "Roaming"), "LOCALAPPDATA": os.path.join(home, "Local")})
    else:
        env.update({"HOME": home, "XDG_CONFIG_HOME": os.path.join(home, ".config"),
                    "XDG_DATA_HOME": os.path.join(home, ".local", "share")})
    screen = cap_screen_id(binary, env)
    path = os.path.join(media_dir, os.path.basename(run_dir) + ".cap") if media_dir else os.path.join(run_dir, "rec.cap")
    target = ["--window", cap_window_id(binary, env, CAP_WINDOW[0])] if CAP_WINDOW[0] else ["--screen", screen]
    args = [binary, "--log-level", CAP_LOG_LEVEL, "record", "start", *target, "--mode", CAP_MODE[0]] + \
        ([] if CAP_DEFAULT_FPS[0] else ["--fps", str(fps)]) + ["--duration", str(total_s if not kill_at else total_s + 60), "--path", path,
            "--format", "json"]
    if audio:
        args.append("--system-audio")
        if mic:
            args += ["--mic", mic]
    t_launch = now_ns()
    errf = open(os.path.join(run_dir, "cap.stderr.log"), "w")
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errf, stdin=subprocess.DEVNULL, env=env, text=True)
    smpl.set_root(p.pid)
    started = None
    events = []
    killer = None
    if kill_at:
        def _kill():
            while started is None and p.poll() is None:
                time.sleep(0.05)
            time.sleep(kill_at)
            res["stop_req"] = now_ns()
            for c in psutil.Process(p.pid).children(recursive=True):
                try:
                    c.kill()
                except psutil.Error:
                    pass
            p.kill()
        res = {}
        killer = threading.Thread(target=_kill, daemon=True)
        killer.start()
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            events.append({"raw": line[:300]})
            continue
        events.append(ev)
        if ev.get("type") == "started" and started is None:
            started = now_ns()
            smpl.mark("rec_start")
    p.wait()
    rc = p.returncode
    t_end = now_ns()
    smpl.mark("rec_end")
    errf.close()
    if started is None:
        tail = open(os.path.join(run_dir, "cap.stderr.log"), errors="replace").read()[-1500:]
        raise RuntimeError(f"cap exited {rc} without starting: {events} {tail}")
    stopped = [e for e in events if e.get("type") == "stopped"]
    stop_req = res["stop_req"] if kill_at else started + int(total_s * 1e9)
    return {"media": path, "rc": rc, "t_launch": t_launch, "t_start": started, "t_stop": t_end,
            "rec_stop_requested": stop_req, "events": events[-4:], "screen": screen,
            "cap_log": cap_log_facts(os.path.join(run_dir, "cap.stderr.log")),
            "startup_ms": round((started - t_launch) / 1e6, 1),
            "finalize_ms": round((t_end - stop_req) / 1e6, 1) if (stopped or kill_at) else None,
            "killed": bool(kill_at)}


# ------------------------------------------------------------------ A/V sync

def ffprobe_streams(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
                       capture_output=True, text=True)
    return json.loads(r.stdout or "{}")


def beep_onsets(path, stream_index=0, offset=0.0):
    rate = 8000
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", f"0:a:{stream_index}", "-ac", "1",
                          "-ar", str(rate), "-f", "s16le", "-"], capture_output=True).stdout
    import array
    import math
    smp = array.array("h")
    smp.frombytes(raw[: len(raw) // 2 * 2])
    if not smp:
        return [], None, 0.0
    win = 40
    k = 2 * math.cos(2 * math.pi * 1000 / rate)
    env = []
    for s in range(0, len(smp) - win, win):
        q1 = q2 = 0.0
        for x in smp[s:s + win]:
            q0 = k * q1 - q2 + x
            q2, q1 = q1, q0
        env.append(math.sqrt(max(q1 * q1 + q2 * q2 - k * q1 * q2, 0)) / win)
    peak = max(env) if env else 0
    ons = []
    if peak > 0:
        thr = peak * 0.3
        last = -10
        for i, e in enumerate(env):
            t = i * win / rate
            if e >= thr and t - last > 0.5:
                ons.append(t + offset)
                last = t
    rms = math.sqrt(sum(x * x for x in smp[::8]) / max(1, len(smp[::8])))
    return ons, round(20 * math.log10(max(rms, 1e-9) / 32768), 1), len(smp) / rate


def av_sync(media, stim_dir, kind):
    """Beep (played right after frame k*hz was presented) against the pts of the first frame showing idx >= k*hz.
    Returns per-track median offset (audio minus video, ms), spread and drift (last minus first)."""
    stim = json.load(open(os.path.join(stim_dir, "stimulus.json")))
    hz = stim["hz_requested"]
    beeps = []
    bp = os.path.join(stim_dir, "beeps.csv")
    if os.path.exists(bp):
        beeps = [int(r["idx"]) for r in csv.DictReader(open(bp))]
    tracks = []
    if kind == "cap":
        segs = sorted(glob.glob(os.path.join(media, "content", "segments", "segment-*")))
        meta = json.load(open(os.path.join(media, "recording-meta.json")))
        s0 = (meta.get("segments") or [{}])[0] if isinstance(meta.get("segments"), list) else {}
        vid = os.path.join(media, s0.get("display", {}).get("path", "")) if s0.get("display") else None
        if not vid or not os.path.exists(vid):
            cand = glob.glob(os.path.join(segs[0], "display*")) if segs else []
            vid = cand[0] if cand else None
        dstart = float(s0.get("display", {}).get("start_time") or 0)
        for key in ("mic", "system_audio"):
            m = s0.get(key)
            if m and m.get("path"):
                ap = os.path.join(media, m["path"])
                if os.path.exists(ap):
                    tracks.append((key, ap, 0, float(m.get("start_time") or 0) - dstart))
        video_media = vid
    else:
        video_media = media
        info = ffprobe_streams(media)
        vst = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
        ast = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
        v0 = float(vst[0].get("start_time") or 0) if vst else 0
        for i, s in enumerate(ast):
            tracks.append(({0: "desktop", 1: "mic"}.get(i, f"track{i}"), media, i, float(s.get("start_time") or 0) - v0))
    if not video_media or not tracks:
        return {"tracks": [], "note": "no video or no audio"}
    st = ffprobe_streams(video_media)["streams"]
    vs = [s for s in st if s.get("codec_type") == "video"][0]
    frames, _ = anz.decode_codes(video_media, stim, vs["width"], vs["height"])
    v0 = float(vs.get("start_time") or 0)
    first_pts = {}
    for pts, idx, _ in frames:
        if idx is not None and idx not in first_pts:
            first_pts[idx] = pts - v0
    idxs = sorted(first_pts)
    out = {"beeps_played": len(beeps), "tracks": []}
    for name, path, si, off in tracks:
        ons, rms, dur = beep_onsets(path, si, off)
        sync = []
        for b in beeps:
            j = next((i for i in idxs if i >= b), None)
            if j is None or j - b > 3:
                continue
            vt = first_pts[j] - (j - b) / hz
            near = min(ons, key=lambda t: abs(t - vt)) if ons else None
            if near is not None and abs(near - vt) < 0.45:
                sync.append((vt, (near - vt) * 1000))
        tr = {"track": name, "beeps_found": len(ons), "matched": len(sync), "rms_dbfs": rms, "duration_s": round(dur, 2)}
        if sync:
            vals = sorted(s[1] for s in sync)
            tr["sync_median_ms"] = round(vals[len(vals) // 2], 1)
            tr["sync_spread_ms"] = round(vals[-1] - vals[0], 1)
            slope, _ = anz.linfit([s[0] / 60 for s in sync], [s[1] for s in sync])
            tr["drift_ms_per_min"] = round(slope, 2) if slope is not None else None
            tr["first_last_ms"] = [round(sync[0][1], 1), round(sync[-1][1], 1)]
        out["tracks"].append(tr)
    return out


# ------------------------------------------------------------------ playability

def plays(media, kind):
    """Decode the whole file (Cap: display video + audio tracks) with ffmpeg -xerror; returns errors and duration."""
    targets = []
    if kind == "cap":
        for f in glob.glob(os.path.join(media, "content", "segments", "segment-*", "*")):
            if os.path.splitext(f)[1].lower() in (".mp4", ".m4a", ".ogg", ".mkv", ".mov", ".m4s") and "init" not in f:
                targets.append(f)
    elif media:
        targets = [media]
    out = []
    for t in targets:
        r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", t, "-f", "null", "-"], capture_output=True,
                           text=True, timeout=1800)
        d = ffprobe_streams(t).get("format", {}).get("duration")
        out.append({"file": os.path.relpath(t, media) if kind == "cap" else os.path.basename(t), "rc": r.returncode,
                    "errors": len(r.stderr.splitlines()), "first_error": r.stderr.splitlines()[0][:200] if r.stderr else None,
                    "duration": float(d) if d else None})
    return out


# ------------------------------------------------------------------ stress

class Stress:
    def __init__(self, n):
        code = "import time\nwhile True:\n  x=0\n  for i in range(100000): x+=i*i\n"
        self.ps = [subprocess.Popen([PY, "-c", code]) for _ in range(n)]

    def stop(self):
        for p in self.ps:
            p.kill()
        for p in self.ps:
            p.wait()


# ------------------------------------------------------------------ runner

def parse_recorders(specs):
    out = []
    for s in specs:
        name, spec = s.split("=", 1)
        kind, _, arg = spec.partition(":")
        out.append({"name": name, "kind": kind, "arg": arg})
    return out


def cap_rows(results, scene, fps):
    return [r for r in results if r.get("kind") == "cap" and r["scene"] == scene and r["fps"] == fps and r.get("analysis")]


def one_run(cfg, rec, scene, fps, rep, order, results, out_dir, encoder):
    run_id = f"{cfg.machine}-{rec['name']}-{scene}{'-av' if cfg.audio else ''}-{fps}-r{rep}-{order:03d}{cfg.tag}"
    run_dir = os.path.join(out_dir, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    total = cfg.warmup + cfg.duration
    row = {"run_id": run_id, "machine": cfg.machine, "recorder": rec["name"], "kind": rec["kind"], "scene": scene,
           "fps": fps, "rep": rep, "order": order, "warmup_s": cfg.warmup, "duration_s": cfg.duration,
           "audio": cfg.audio, "tag": cfg.tag, "wall_start": time.strftime("%Y-%m-%dT%H:%M:%S"), "host": platform.node(),
           "os": platform.platform(), "stress": cfg.stress, "kill_at": cfg.kill_at}
    if rec["kind"] == "cap":
        b, _ = parse_cap_arg(rec["arg"])
        row["binary"] = b
        row["binary_sha256_16"] = sha16(b)
    log("run", run_id)
    stim = Stimulus(scene, os.path.join(run_dir, "stim"), beep=cfg.audio, hz=cfg.stim_hz)
    stress = None
    stress_timer = None
    try:
        time.sleep(2.0)
        s = Sampler(1.0)
        s.start()
    except BaseException:
        stim.stop()
        raise
    if cfg.stress:
        def _st():
            nonlocal stress
            stress = Stress(cfg.stress)
        stress_timer = threading.Timer(cfg.stress_at, _st)
        stress_timer.start()
    ev_log = []
    if cfg.event:
        def _events():
            while "rec_start" not in s.marks:
                time.sleep(0.02)
            t0 = s.marks["rec_start"]
            for spec in sorted(cfg.event, key=lambda x: float(x.split(":", 1)[0])):
                at, cmd = spec.split(":", 1)
                while (now_ns() - t0) / 1e9 < float(at):
                    time.sleep(0.02)
                r_ = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
                ev_log.append({"at": float(at), "t_ns": now_ns(), "cmd": cmd, "rc": r_.returncode,
                               "out": (r_.stdout + r_.stderr)[-400:]})
        threading.Thread(target=_events, daemon=True).start()
    try:
        if rec["kind"] == "cap":
            r = run_cap(rec["arg"], stim.info, fps, total, run_dir, s, os.path.join(out_dir, "home-" + rec["name"]),
                        cfg.audio, cfg.mic, cfg.kill_at, cfg.media_dir)
        else:
            crs = cap_rows(results, scene, fps)
            br = sorted(x["analysis"]["bitrate_kbps_window"] for x in crs if x["analysis"].get("bitrate_kbps_window"))
            br = br[len(br) // 2] if br else cfg.obs_fallback_kbps
            facts = crs[0]["analysis"]["encoder"] if crs else None
            bf = bool(facts and facts.get("reordered_packets"))
            keyint = max(1, round(facts["gop_s"])) if facts and facts.get("gop_s") else 2
            row["obs_requested"] = {"mode": rec["arg"], "bitrate_kbps": br, "keyint_s": keyint, "bframes": bf,
                                    "encoder": encoder}
            r = run_obs(rec["arg"] or "matched", stim.info, fps, total, run_dir, s, cfg.audio, br, keyint, bf, encoder,
                        cfg.kill_at, cfg.obs_pause, cfg.media_dir)
        time.sleep(1.0)
    finally:
        if stress_timer:
            stress_timer.cancel()
        if stress:
            if cfg.stress_hold:
                time.sleep(cfg.stress_hold)
            stress.stop()
        s.stop()
        stim.stop()
    row["events_run"] = ev_log
    if cfg.media_dir:
        row["media_dir_free_mb_after"] = round(shutil.disk_usage(cfg.media_dir).free / 1048576, 1)
    row["stimulus"] = stim.info.get("summary")
    row["stimulus_display"] = {k: stim.info.get(k) for k in ("px_w", "px_h", "hz_requested", "screen_max_fps")}
    row["recorder_result"] = {k: v for k, v in r.items() if k not in ("t_launch", "t_start", "t_stop", "rec_stop_requested")}
    win_from = r["t_start"] + int(cfg.warmup * 1e9)
    win_to = r.get("rec_stop_requested") or r["t_stop"]
    nv = getattr(s, "nvrows", None)
    row["resources"] = summarize(s.samples, win_from, win_to, nv)
    row["resources_whole"] = summarize(s.samples, r["t_launch"], r["t_stop"], nv)
    json.dump({"samples": s.samples, "marks": s.marks, "nv": nv}, open(os.path.join(run_dir, "samples.json"), "w"))
    media = r.get("media")
    row["media"] = media
    if media and os.path.exists(media):
        try:
            row["analysis"] = anz.analyze(media, os.path.join(run_dir, "stim"), fps, cfg.warmup, r["t_start"])
        except BaseException as e:
            row["analysis_error"] = str(e)[:2000]
        if cfg.audio:
            try:
                row["av"] = av_sync(media, os.path.join(run_dir, "stim"), rec["kind"])
            except BaseException as e:
                row["av_error"] = str(e)[:1000]
        if cfg.plays:
            try:
                row["plays"] = plays(media, rec["kind"])
            except BaseException as e:
                row["plays_error"] = str(e)[:500]
        if rec["kind"] == "cap" and cfg.validate:
            b, extra = parse_cap_arg(rec["arg"])
            v = subprocess.run([b, "project", "validate", media, "--format", "json"], capture_output=True, text=True,
                               env=dict(os.environ, **extra), timeout=300)
            row["validate"] = {"rc": v.returncode, "out": (v.stdout or v.stderr)[-1500:]}
        if rec["kind"] == "cap" and cfg.export:
            b, extra = parse_cap_arg(rec["arg"])
            outmp4 = os.path.join(run_dir, "export.mp4")
            t_ex = now_ns()
            v = subprocess.run([b, "export", media, "--output", outmp4, "--json"], capture_output=True,
                               text=True, env=dict(os.environ, **extra), timeout=1200)
            row["export"] = {"rc": v.returncode, "s": round((now_ns() - t_ex) / 1e9, 2), "out": (v.stdout + v.stderr)[-1200:]}
            if os.path.exists(outmp4):
                row["export"]["plays"] = plays(outmp4, "obs")
                try:
                    row["export"]["analysis"] = anz.analyze(outmp4, os.path.join(run_dir, "stim"), fps, cfg.warmup)
                except BaseException as e:
                    row["export"]["analysis_error"] = str(e)[:500]
                if cfg.audio:
                    try:
                        row["export"]["av"] = av_sync(outmp4, os.path.join(run_dir, "stim"), "obs")
                    except BaseException as e:
                        row["export"]["av_error"] = str(e)[:500]
                if not cfg.keep:
                    os.remove(outmp4)
        if not cfg.keep:
            try:
                if os.path.isdir(media):
                    shutil.rmtree(media, ignore_errors=True)
                else:
                    os.remove(media)
            except OSError:
                pass
    else:
        row["analysis_error"] = f"no media ({media})"
    results.append(row)
    with open(os.path.join(out_dir, "runs.jsonl"), "a") as f:
        f.write(json.dumps(row) + "\n")
    a = row.get("analysis", {}).get("window", {})
    res = row.get("resources") or {}
    log("done", run_id, "uniq", row.get("analysis", {}).get("effective_fps_unique"), "missed", a.get("missed"),
        "dup", a.get("duplicates"), "cpu", res.get("cpu_s_per_s"), "mem", res.get("mem_steady_mb"),
        "kbps", row.get("analysis", {}).get("bitrate_kbps_window"), "fin", r.get("finalize_ms"),
        "err", row.get("analysis_error", "")[:120])


def cmd_run(a):
    CAP_MODE[0] = a.cap_mode
    CAP_WINDOW[0] = a.cap_window
    CAP_DEFAULT_FPS[0] = a.cap_default_fps
    os.makedirs(a.out, exist_ok=True)
    recs = parse_recorders(a.recorder)
    results = []
    p = os.path.join(a.out, "runs.jsonl")
    if os.path.exists(p):
        results = [json.loads(l) for l in open(p) if l.strip()]
    encoder = None
    if any(r["kind"] == "obs" for r in recs):
        encoder = obs_pick_encoder()
        log("obs encoder", encoder)
    order = len(results)
    scenes = a.scenes.split(",")
    fpss = [int(x) for x in a.fps.split(",")]
    for rep in range(a.rep_start, a.rep_start + a.reps):
        for scene in scenes:
            for fps in fpss:
                rr = list(recs)
                caps = [r for r in rr if r["kind"] == "cap"]
                obs = [r for r in rr if r["kind"] != "cap"]
                random.Random(rep * 1000 + fps + hash(scene) % 97).shuffle(caps)
                for rec in caps + obs:
                    order += 1
                    try:
                        one_run(a, rec, scene, fps, rep, order, results, a.out, encoder)
                    except BaseException as e:
                        log("RUN FAILED", rec["name"], scene, fps, rep, str(e)[:800])
                        with open(os.path.join(a.out, "failures.jsonl"), "a") as f:
                            f.write(json.dumps({"recorder": rec["name"], "scene": scene, "fps": fps, "rep": rep,
                                                "tag": a.tag, "error": str(e)[:3000]}) + "\n")
                        if isinstance(e, KeyboardInterrupt):
                            raise
                    time.sleep(a.gap)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    r = sub.add_parser("run")
    r.add_argument("--out", required=True)
    r.add_argument("--recorder", action="append", required=True)
    r.add_argument("--scenes", default="scroll")
    r.add_argument("--fps", default="60")
    r.add_argument("--reps", type=int, default=3)
    r.add_argument("--rep-start", type=int, default=1)
    r.add_argument("--duration", type=float, default=20)
    r.add_argument("--warmup", type=float, default=3)
    r.add_argument("--machine", default="win" if WIN else "linux")
    r.add_argument("--audio", action="store_true")
    r.add_argument("--mic")
    r.add_argument("--keep", action="store_true")
    r.add_argument("--plays", action="store_true")
    r.add_argument("--validate", action="store_true")
    r.add_argument("--stress", type=int, default=0)
    r.add_argument("--stress-at", type=float, default=5)
    r.add_argument("--stress-hold", type=float, default=0)
    r.add_argument("--kill-at", type=float)
    r.add_argument("--event", action="append", help="SECS:shell command, run SECS after recording start")
    r.add_argument("--obs-pause", help="AT:LEN pause OBS at AT s for LEN s")
    r.add_argument("--cap-mode", default="studio", choices=["studio", "instant"])
    r.add_argument("--cap-window", help="record this window (title substring) instead of the screen")
    r.add_argument("--cap-default-fps", action="store_true", help="do not pass --fps to Cap (its default for the mode)")
    r.add_argument("--stim-hz", type=float, help="stimulus rate when the display mode is not what SDL reports")
    r.add_argument("--media-dir", help="write recordings here instead of the run dir (slow or nearly full volume)")
    r.add_argument("--export", action="store_true", help="cap export the project (runs recovery on killed projects)")
    r.add_argument("--tag", default="")
    r.add_argument("--gap", type=float, default=3)
    r.add_argument("--obs-fallback-kbps", type=int, default=20000)
    a = ap.parse_args()
    if a.cmd == "run":
        cmd_run(a)


if __name__ == "__main__":
    main()
