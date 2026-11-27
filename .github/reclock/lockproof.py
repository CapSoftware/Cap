"""Plain, --duration and crash cases for the recording lock proof, one case per call.
Usage: lockproof.py --cap <cap> --case plain|duration|crash --mode studio|instant --dir <dir> --out <dir> --tag <t>"""
import argparse, json, os, shutil, subprocess, sys, time

import psutil


def meta_status(project):
    try:
        with open(os.path.join(project, "recording-meta.json")) as f:
            meta = json.load(f)
    except (OSError, ValueError) as error:
        return f"unreadable: {type(error).__name__}"
    status = meta.get("status")
    if isinstance(status, dict):
        return status.get("status")
    if status:
        return status
    text = json.dumps(meta)
    for word in ("InProgress", "inProgress", "Failed", "failed", "error"):
        if word in text:
            return f"instant:{word}"
    return "instant:ok" if "fps" in text else "none"


def run(cmd, timeout):
    t = time.monotonic()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"code": p.returncode, "secs": round(time.monotonic() - t, 3),
                "stdout": p.stdout[-600:], "stderr": p.stderr[-600:]}
    except subprocess.TimeoutExpired:
        return {"code": "timeout", "secs": round(time.monotonic() - t, 3)}


def probe(path, *entries):
    r = subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
                        ",".join(entries), "-of", "json", path], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {}


def export(cap, project, mode, out, tag):
    mp4 = os.path.join(out, f"{tag}.mp4")
    cmd = [cap, "export", project, "--output", mp4, "--json"]
    if mode == "studio":
        cmd += ["--fps", "15", "--resolution", "640x360", "--quality", "potato"]
    r = run(cmd, 1200)
    if os.path.exists(mp4):
        info = probe(mp4, "format=duration", "stream=nb_read_packets")
        r["duration"] = info.get("format", {}).get("duration")
        os.remove(mp4)
    return r


def start_detached(cap, mode, project):
    screens = json.loads(subprocess.run([cap, "targets", "screens", "--json"], capture_output=True, text=True,
                                        timeout=60).stdout)
    t = time.monotonic()
    p = subprocess.run([cap, "record", "start", "--screen", str(screens[0]["id"]), "--mode", mode,
                        "--path", project, "--json", "--detach"], capture_output=True, text=True, timeout=180)
    secs = round(time.monotonic() - t, 3)
    started = next((json.loads(l) for l in p.stdout.splitlines() if '"started"' in l), None)
    if not started:
        raise SystemExit(f"start failed {p.returncode}: {p.stdout[-400:]} {p.stderr[-400:]}")
    return started["recordingId"], started["pid"], secs


def media_frames(project, mode):
    if mode == "instant":
        path = os.path.join(project, "content", "output.mp4")
    else:
        path = None
        for root, _, files in os.walk(os.path.join(project, "content")):
            if "display.mp4" in files:
                path = os.path.join(root, "display.mp4")
                break
    if not path or not os.path.exists(path):
        return None
    info = probe(path, "format=duration", "stream=nb_read_packets")
    streams = info.get("streams") or [{}]
    return {"duration": info.get("format", {}).get("duration"), "frames": streams[0].get("nb_read_packets")}


def main():
    a = argparse.ArgumentParser()
    for name in ("--cap", "--case", "--mode", "--dir", "--out", "--tag"):
        a.add_argument(name, required=True)
    args = a.parse_args()
    os.makedirs(args.out, exist_ok=True)
    work = os.path.join(args.dir, "lockproof")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    project = os.path.join(work, f"{args.tag}.cap")
    report = {"tag": args.tag, "case": args.case, "mode": args.mode}
    if args.case == "duration":
        screens = json.loads(subprocess.run([args.cap, "targets", "screens", "--json"], capture_output=True,
                                            text=True, timeout=60).stdout)
        report["record"] = run([args.cap, "record", "start", "--screen", str(screens[0]["id"]), "--mode", args.mode,
                                "--path", project, "--json", "--duration", "8"], 300)
    else:
        rid, pid, report["start_secs"] = start_detached(args.cap, args.mode, project)
        time.sleep(10)
        status = run([args.cap, "record", "status", "--json"], 60)
        report["status_code"] = status["code"]
        report["status_has_session"] = rid in (status.get("stdout") or "")
        if args.case == "crash":
            psutil.Process(pid).kill()
            psutil.Process(pid).wait(30) if psutil.pid_exists(pid) else None
            time.sleep(1)
            report["killed"] = True
        else:
            report["stop"] = run([args.cap, "record", "stop", "--id", rid, "--json", "--timeout", "300"], 400)
    report["parent_after_stop"] = sorted(os.listdir(work))
    report["status_final"] = meta_status(project)
    report["validate"] = run([args.cap, "project", "validate", project, "--json"], 120)["code"]
    report["export"] = export(args.cap, project, args.mode, args.out, args.tag)
    report["media"] = media_frames(project, args.mode)
    report["validate_after_export"] = run([args.cap, "project", "validate", project, "--json"], 120)["code"]
    report["parent_after_export"] = sorted(os.listdir(work))
    with open(os.path.join(args.out, f"{args.tag}.json"), "w") as f:
        json.dump(report, f, indent=1)
    print("LOCKPROOF " + json.dumps({
        "tag": args.tag, "case": args.case, "mode": args.mode,
        "start_secs": report.get("start_secs"),
        "status": report.get("status_code"), "status_has_session": report.get("status_has_session"),
        "record": (report.get("record") or {}).get("code"), "record_secs": (report.get("record") or {}).get("secs"),
        "stop": (report.get("stop") or {}).get("code"), "stop_secs": (report.get("stop") or {}).get("secs"),
        "stop_err": ((report.get("stop") or {}).get("stderr") or "")[-160:],
        "final": report["status_final"], "validate": report["validate"],
        "export": report["export"]["code"], "export_secs": report["export"]["secs"],
        "export_duration": report["export"].get("duration"),
        "export_err": (report["export"].get("stderr") or "")[-160:],
        "media": report["media"], "validate_after_export": report["validate_after_export"],
        "parent_after_stop": report["parent_after_stop"], "parent_after_export": report["parent_after_export"],
    }), flush=True)
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
