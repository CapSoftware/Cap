"""A detached recording whose Stop is held back (CAP_DIAG_STOP_DELAY_S) keeps writing in its own
process while another process runs `cap export` on the same project. Usage:
concurrent.py --recorder <diag cap> --exporter <cap> --validator <cap> --dir <roomy dir> --out <dir> --tag <tag>"""
import argparse, json, os, shutil, subprocess, sys, time


def meta_status(project):
    try:
        with open(os.path.join(project, "recording-meta.json")) as f:
            meta = json.load(f)
    except (OSError, ValueError) as error:
        return f"unreadable: {error}"
    status = meta.get("status")
    return status.get("status") if isinstance(status, dict) else (status or "none")


def run(cmd, timeout):
    t = time.monotonic()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"code": p.returncode, "secs": round(time.monotonic() - t, 2),
                "stdout": p.stdout[-1500:], "stderr": p.stderr[-1500:]}
    except subprocess.TimeoutExpired:
        return {"code": "timeout", "secs": timeout}


def main():
    a = argparse.ArgumentParser()
    for name in ("--recorder", "--exporter", "--validator", "--dir", "--out", "--tag"):
        a.add_argument(name, required=True)
    a.add_argument("--delay", default="60")
    args = a.parse_args()
    os.makedirs(args.out, exist_ok=True)
    work = os.path.join(args.dir, "concurrent")
    if os.path.exists(work):
        shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    project = os.path.join(work, f"{args.tag}.cap")
    screens = json.loads(subprocess.run([args.recorder, "targets", "screens", "--json"],
                                        capture_output=True, text=True, timeout=60).stdout)
    env = dict(os.environ, CAP_DIAG_STOP_DELAY_S=args.delay)
    start = subprocess.run([args.recorder, "record", "start", "--screen", str(screens[0]["id"]), "--mode", "studio",
                            "--path", project, "--json", "--detach"], capture_output=True, text=True, env=env, timeout=120)
    rid = next(json.loads(l)["recordingId"] for l in start.stdout.splitlines() if '"started"' in l)
    time.sleep(10)
    t_stop = time.monotonic()
    stop = subprocess.Popen([args.recorder, "record", "stop", "--id", rid, "--json", "--timeout", "400"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(5)
    report = {"tag": args.tag, "status_before_export": meta_status(project)}
    report["export_during"] = run([args.exporter, "export", project, "--output",
                                   os.path.join(args.out, f"{args.tag}-during.mp4"), "--json"], 300)
    report["status_after_export"] = meta_status(project)
    report["export_during_secs_after_stop_request"] = round(time.monotonic() - t_stop, 1)
    out, err = stop.communicate(timeout=600)
    report["stop"] = {"code": stop.returncode, "secs": round(time.monotonic() - t_stop, 1),
                      "events": [json.loads(l) for l in out.splitlines() if l.startswith("{")], "stderr": err[-1500:]}
    report["status_final"] = meta_status(project)
    report["validate_final"] = run([args.validator, "project", "validate", project, "--json"], 120)
    mp4 = os.path.join(args.out, f"{args.tag}-final.mp4")
    report["export_final"] = run([args.validator, "export", project, "--output", mp4, "--json"], 600)
    if os.path.exists(mp4):
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4],
                           capture_output=True, text=True)
        report["final_duration"] = r.stdout.strip()
        os.remove(mp4)
    with open(os.path.join(args.out, f"{args.tag}.json"), "w") as f:
        json.dump(report, f, indent=1)
    print("CONCURRENT " + json.dumps({
        "tag": args.tag,
        "before": report["status_before_export"],
        "export_during": report["export_during"]["code"],
        "export_during_err": report["export_during"].get("stderr", "")[-200:],
        "after_export": report["status_after_export"],
        "stop": report["stop"]["code"],
        "stop_secs": report["stop"]["secs"],
        "final": report["status_final"],
        "validate": report["validate_final"]["code"],
        "export_final": report["export_final"]["code"],
        "final_duration": report.get("final_duration"),
    }), flush=True)
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
