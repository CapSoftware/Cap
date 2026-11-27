"""Desktop app cases for the recording lock proof, BASE vs HEAD on one machine.
desk.py <cfg.json>; cfg: out, work, arms {base|head: {app, cli}}, cases [names], pairs."""
import calendar, json, os, re, shutil, subprocess, sys, time

import psutil

WIN = sys.platform == "win32"
cfg = json.load(open(sys.argv[1]))
OUT, WORK = cfg["out"], cfg["work"]
os.makedirs(OUT, exist_ok=True)
if sys.platform.startswith("linux"):
    lib = os.path.join(os.path.dirname(cfg["arms"]["base"]["app"]), "lib")
    os.environ["LD_LIBRARY_PATH"] = lib + os.pathsep + os.environ.get("LD_LIBRARY_PATH", "")
progress = open(os.path.join(OUT, "progress.log"), "a", buffering=1)
TS = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
KEYS = ("still being recorded", "another Cap process", "Recording is in progress", "RecordingInProgress",
        "recover", "Recover", "salvage", "finaliz", "Failed", "panicked")


def say(msg):
    line = time.strftime("%H:%M:%S ") + msg
    progress.write(line + "\n")
    print(line, flush=True)


def ts_of(line):
    m = TS.search(line)
    if not m:
        return None
    whole, frac = m.group(1).split(".")
    return calendar.timegm(time.strptime(whole, "%Y-%m-%dT%H:%M:%S")) + float("0." + frac)


def profile(name):
    p = os.path.join(WORK, name)
    shutil.rmtree(p, ignore_errors=True)
    os.makedirs(os.path.join(p, "recordings"))
    os.makedirs(os.path.join(p, "logs"))
    store = {"general_settings": {"hasCompletedStartup": True, "hasCompletedOnboarding": True,
                                  "enableNotifications": False, "enableTelemetry": False,
                                  "recordingCountdown": 0},
             "recording_start_safety": {"confirmBeforeRecordingWithoutMicrophone": False}}
    json.dump(store, open(os.path.join(p, "store"), "w"))
    return p, os.path.join(p, "recordings")


def launch(arm, p, r, log, extra):
    env = dict(os.environ)
    env.update({"CAP_GPUI_APP_DATA_DIR": p, "CAP_GPUI_RECORDINGS_DIR": r, "CAP_GPUI_LOG_DIR": os.path.join(p, "logs"),
                "RUST_LOG": "info", "CAP_GPUI_AUTO_NO_MIC": "1"})
    env.update(extra)
    kw = {"creationflags": 0x00000200} if WIN else {"start_new_session": True}
    fh = open(log, "ab")
    return subprocess.Popen([cfg["arms"][arm]["app"]], env=env, stdout=fh, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, **kw)


def kill_tree(proc):
    try:
        root = psutil.Process(proc.pid)
        for q in root.children(recursive=True) + [root]:
            try:
                q.kill()
            except psutil.Error:
                pass
    except psutil.Error:
        pass
    try:
        proc.wait(15)
    except Exception:
        pass


def log_text(log):
    try:
        return ANSI.sub("", open(log, "rb").read().decode("utf-8", "replace"))
    except OSError:
        return ""


def wait_log(log, key, timeout, proc=None):
    end = time.time() + timeout
    while time.time() < end:
        if key in log_text(log):
            return True
        if proc is not None and proc.poll() is not None:
            return key in log_text(log)
        time.sleep(0.25)
    return False


def log_time(log, key):
    for line in log_text(log).splitlines():
        if key in line:
            return ts_of(line)
    return None


def evidence(log):
    return [l[-220:] for l in log_text(log).splitlines() if any(k in l for k in KEYS)][-12:]


def meta_status(project):
    try:
        meta = json.load(open(os.path.join(project, "recording-meta.json")))
    except (OSError, ValueError) as error:
        return f"unreadable: {type(error).__name__}"
    status = meta.get("status")
    return status.get("status") if isinstance(status, dict) else (status or "none")


def run(cmd, timeout):
    t = time.monotonic()
    try:
        q = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"code": q.returncode, "secs": round(time.monotonic() - t, 2), "err": (q.stderr or q.stdout)[-300:]}
    except subprocess.TimeoutExpired:
        return {"code": "timeout", "secs": round(time.monotonic() - t, 2)}


def export(arm, project, tag):
    mp4 = os.path.join(WORK, f"{tag}.mp4")
    r = run([cfg["arms"][arm]["cli"], "export", project, "--output", mp4, "--json", "--fps", "15",
             "--resolution", "640x360", "--quality", "potato"], 1200)
    if os.path.exists(mp4):
        q = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4],
                           capture_output=True, text=True)
        r["duration"] = q.stdout.strip()
        os.remove(mp4)
    return r


def validate(arm, project):
    return run([cfg["arms"][arm]["cli"], "project", "validate", project, "--json"], 120)["code"]


def projects_in(r):
    return [os.path.join(r, d) for d in sorted(os.listdir(r))
            if os.path.isfile(os.path.join(r, d, "recording-meta.json"))]


def case_cli_then_app(arm, n):
    p, r = profile(f"a-{arm}-{n}")
    project = os.path.join(r, f"cli-{arm}-{n}.cap")
    cli = cfg["arms"][arm]["cli"]
    screens = json.loads(subprocess.run([cli, "targets", "screens", "--json"], capture_output=True, text=True,
                                        timeout=60).stdout)
    start = subprocess.run([cli, "record", "start", "--screen", str(screens[0]["id"]), "--mode", "studio",
                            "--path", project, "--json", "--detach"], capture_output=True, text=True, timeout=180)
    started = next(json.loads(l) for l in start.stdout.splitlines() if '"started"' in l)
    t0 = time.monotonic()
    time.sleep(8)
    log = os.path.join(OUT, f"a-{arm}-{n}.log")
    app = launch(arm, p, r, log, {"CAP_GPUI_AUTO_RECOVER": "1", "CAP_GPUI_AUTO_EDITOR": project})
    time.sleep(25)
    kill_tree(app)
    res = {"case": "cli_then_app", "arm": arm, "n": n, "status_after_app": meta_status(project),
           "app_evidence": evidence(log)}
    time.sleep(max(0, 45 - (time.monotonic() - t0)))
    res["recorded_secs"] = round(time.monotonic() - t0, 1)
    res["stop"] = run([cli, "record", "stop", "--id", started["recordingId"], "--json", "--timeout", "300"], 400)
    res["final"] = meta_status(project)
    res["validate"] = validate(arm, project)
    res["export"] = export(arm, project, f"a-{arm}-{n}")
    return res


def case_app_then_cli(arm, n):
    p, r = profile(f"b-{arm}-{n}")
    log = os.path.join(OUT, f"b-{arm}-{n}.log")
    app = launch(arm, p, r, log, {"CAP_GPUI_AUTO_RECORD": "studio:30"})
    res = {"case": "app_then_cli", "arm": arm, "n": n}
    if not wait_log(log, "recording started", 90, app):
        kill_tree(app)
        res["error"] = "app did not start recording"
        res["tail"] = log_text(log)[-1500:]
        return res
    time.sleep(8)
    project = projects_in(r)[0]
    res["status_before_export"] = meta_status(project)
    res["cli_export_during"] = export(arm, project, f"b-during-{arm}-{n}")
    res["status_after_export"] = meta_status(project)
    res["finished"] = wait_log(log, "recording finished", 180, app)
    time.sleep(3)
    kill_tree(app)
    res["app_evidence"] = evidence(log)
    res["final"] = meta_status(project)
    res["validate"] = validate(arm, project)
    res["export"] = export(arm, project, f"b-{arm}-{n}")
    return res


def case_plain(arm, n):
    p, r = profile(f"p-{arm}-{n}")
    log = os.path.join(OUT, f"p-{arm}-{n}.log")
    app = launch(arm, p, r, log, {"CAP_GPUI_AUTO_RECORD": "studio:10"})
    finished = wait_log(log, "recording finished", 180, app)
    time.sleep(2)
    kill_tree(app)
    res = {"case": "plain", "arm": arm, "n": n, "finished": finished}
    a, b = log_time(log, "auto-record start requested"), log_time(log, "recording started")
    c, d = log_time(log, "auto-record stop requested"), log_time(log, "recording finished")
    res["start_latency_s"] = round(b - a, 3) if a and b else None
    res["stop_to_finished_s"] = round(d - c, 3) if c and d else None
    found = projects_in(r)
    if found:
        res["final"] = meta_status(found[0])
        res["validate"] = validate(arm, found[0])
        res["export"] = export(arm, found[0], f"p-{arm}-{n}")
    res["errors"] = log_text(log).count(" ERROR ")
    return res


def case_crash(arm, n):
    p, r = profile(f"c-{arm}-{n}")
    log = os.path.join(OUT, f"c-{arm}-{n}.log")
    app = launch(arm, p, r, log, {"CAP_GPUI_AUTO_RECORD": "studio:60"})
    res = {"case": "crash", "arm": arm, "n": n}
    if not wait_log(log, "recording started", 90, app):
        kill_tree(app)
        res["error"] = "app did not start recording"
        return res
    time.sleep(10)
    kill_tree(app)
    project = projects_in(r)[0]
    res["status_after_kill"] = meta_status(project)
    log2 = os.path.join(OUT, f"c2-{arm}-{n}.log")
    app = launch(arm, p, r, log2, {"CAP_GPUI_AUTO_RECOVER": "1"})
    end = time.time() + 90
    while time.time() < end and meta_status(project) not in ("Complete", "Failed"):
        time.sleep(1)
    time.sleep(3)
    kill_tree(app)
    res["recover_evidence"] = evidence(log2)
    res["final"] = meta_status(project)
    res["validate"] = validate(arm, project)
    res["export"] = export(arm, project, f"c-{arm}-{n}")
    return res


def case_delete(arm, n):
    p, r = profile(f"d-{arm}-{n}")
    log = os.path.join(OUT, f"d-{arm}-{n}.log")
    app = launch(arm, p, r, log, {"CAP_GPUI_AUTO_RECORD": "studio:6", "CAP_GPUI_AUTO_DELETE": "1"})
    finished = wait_log(log, "recording finished", 120, app)
    time.sleep(10)
    kill_tree(app)
    left = [d for d in os.listdir(r) if not d.startswith(".")]
    return {"case": "delete", "arm": arm, "n": n, "finished": finished, "projects_left": left,
            "hidden_left": [d for d in os.listdir(r) if d.startswith(".")], "evidence": evidence(log)}


CASES = {"cli_then_app": case_cli_then_app, "app_then_cli": case_app_then_cli, "plain": case_plain,
         "crash": case_crash, "delete": case_delete}

for name in cfg["cases"]:
    pairs = cfg.get("pairs_" + name, cfg["pairs"])
    for i in range(pairs):
        for arm in (("base", "head") if i % 2 == 0 else ("head", "base")):
            try:
                res = CASES[name](arm, i + 1)
            except Exception as error:
                res = {"case": name, "arm": arm, "n": i + 1, "exception": repr(error)}
            json.dump(res, open(os.path.join(OUT, f"{name}-{arm}-{i + 1}.json"), "w"), indent=1)
            say("DESK " + json.dumps(res)[:1500])
            shutil.rmtree(os.path.join(WORK), ignore_errors=True)
            os.makedirs(WORK, exist_ok=True)
