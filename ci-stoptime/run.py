#!/usr/bin/env python3
"""run.py: Cap CLI stop-time harness. Interleaves binaries, scroll stimulus, logs per-stage finalize times.
usage: run.py --out DIR --dur 20 --reps 3 --arm name=/path/cap[;ENV=V] [--arm ...] [--fps 60] [--scene scroll] [--level info]
"""
import argparse, json, os, re, subprocess, sys, time, shutil

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--dur", type=float, default=20)
ap.add_argument("--reps", type=int, default=3)
ap.add_argument("--arm", action="append", required=True)
ap.add_argument("--fps", type=int, default=60)
ap.add_argument("--scene", default="scroll")
ap.add_argument("--level", default="info")
ap.add_argument("--mode", default="studio")
ap.add_argument("--keep", action="store_true")
ap.add_argument("--extra", default="")
ap.add_argument("--wrap", default="", help="prefix command, e.g. 'strace -f -c -o {dir}/strace.txt'")
ap.add_argument("--stim", default="/rig/x/stim.py")
ap.add_argument("--screen", default="0")
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)

arms = []
for s in a.arm:
    name, rest = s.split("=", 1)
    parts = rest.split(";")
    env = dict(p.split("=", 1) for p in parts[1:])
    arms.append((name, parts[0], env))

TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z\s+(\w+)\s+(.*)$")


def ts(s):
    import datetime
    return datetime.datetime.fromisoformat(s[:26]).timestamp()


res = open(os.path.join(a.out, "results.jsonl"), "a")
for rep in range(a.reps):
    order = arms if rep % 2 == 0 else list(reversed(arms))
    for name, binary, aenv in order:
        rd = os.path.join(a.out, f"{name}-r{rep}")
        shutil.rmtree(rd, ignore_errors=True)
        os.makedirs(rd)
        env = dict(os.environ)
        env.update(aenv)
        home = os.path.join(rd, "home")
        os.makedirs(home)
        env.update({"HOME": home, "XDG_CONFIG_HOME": home + "/.config", "XDG_DATA_HOME": home + "/.local/share"})
        stim = subprocess.Popen([sys.executable, a.stim, "--scene", a.scene, "--out", rd + "/stim",
                                 "--duration", str(a.dur + 12)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3)
        path = os.path.join(rd, "rec.cap")
        args = [binary, "--log-level", a.level, "record", "start", "--screen", a.screen, "--mode", a.mode, "--fps", str(a.fps),
                "--duration", str(a.dur), "--path", path, "--format", "json"] + (a.extra.split() if a.extra else [])
        if a.wrap:
            args = a.wrap.format(dir=rd).split() + args
        errf = open(os.path.join(rd, "stderr.log"), "w")
        t0 = time.time()
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errf, env=env, text=True)
        started = stopped = None
        evs = []
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            now = time.time()
            try:
                ev = json.loads(line)
            except Exception:
                continue
            evs.append((now, ev))
            if ev.get("type") == "started" and started is None:
                started = now
            if ev.get("type") == "stopped":
                stopped = now
        p.wait()
        t_exit = time.time()
        errf.close()
        stim.terminate()
        try:
            stim.wait(10)
        except Exception:
            stim.kill()
        stop_req = (started or t0) + a.dur
        stages = []
        lines = open(os.path.join(rd, "stderr.log"), errors="replace").read().splitlines()
        prev = None
        for l in lines:
            l = re.sub(r"\x1b\[[0-9;]*m", "", l)
            m = TS.match(l)
            if not m:
                continue
            t = ts(m.group(1))
            if t < stop_req - 0.5:
                continue
            msg = re.sub(r"\s+", " ", m.group(3))[:200]
            if prev:
                stages.append((round((t - prev[0]) * 1000, 1), prev[1]))
            prev = (t, msg)
        # display.mp4 facts
        facts = {}
        for root, _, files in os.walk(path):
            for f in files:
                if f in ("display.mp4", "camera.mp4"):
                    fp = os.path.join(root, f)
                    facts[os.path.relpath(fp, path)] = os.path.getsize(fp)
        row = {"arm": name, "rep": rep, "dur": a.dur, "fps": a.fps, "scene": a.scene, "mode": a.mode, "rc": p.returncode,
               "finalize_ms": round(((stopped or t_exit) - stop_req) * 1000, 1), "exit_ms": round((t_exit - stop_req) * 1000, 1),
               "files": facts, "top_stages": sorted(stages, reverse=True)[:6]}
        res.write(json.dumps(row) + "\n")
        res.flush()
        print(json.dumps({k: row[k] for k in ("arm", "rep", "finalize_ms", "exit_ms", "rc", "files")}), flush=True)
        for d, msg in sorted(stages, reverse=True)[:3]:
            print("   ", d, msg[:150], flush=True)
        if not a.keep:
            for root, dirs, files in os.walk(path):
                for f in files:
                    if f.endswith((".mp4", ".m4s", ".ogg", ".m4a")):
                        pass
        time.sleep(2)
print("RUN_DONE", flush=True)
