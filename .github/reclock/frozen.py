"""A detached recording whose worker is suspended (so its files stop changing) while another process runs
`cap export` on it, then resumed and stopped. Shows whether an export can publish a recording that is still
being recorded. Usage: frozen.py --recorder <cap> --exporter <cap> --validator <cap> --dir <dir> --out <dir> --tag <t>"""
import argparse, json, os, shutil, signal, subprocess, sys, time

try:
    import psutil
except ImportError:
    psutil = None


def meta_status(project):
    try:
        with open(os.path.join(project, "recording-meta.json")) as f:
            meta = json.load(f)
    except (OSError, ValueError) as error:
        return f"unreadable: {error}"
    status = meta.get("status")
    return status.get("status") if isinstance(status, dict) else (status or "none")


def suspend(pid, on):
    if psutil:
        process = psutil.Process(pid)
        (process.suspend if on else process.resume)()
    else:
        os.kill(pid, signal.SIGSTOP if on else signal.SIGCONT)


def run(cmd, timeout):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"code": p.returncode, "stdout": p.stdout[-800:], "stderr": p.stderr[-800:]}
    except subprocess.TimeoutExpired:
        return {"code": "timeout"}


def main():
    a = argparse.ArgumentParser()
    for name in ("--recorder", "--exporter", "--validator", "--dir", "--out", "--tag"):
        a.add_argument(name, required=True)
    args = a.parse_args()
    os.makedirs(args.out, exist_ok=True)
    work = os.path.join(args.dir, "frozen")
    if os.path.exists(work):
        shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    project = os.path.join(work, f"{args.tag}.cap")
    screens = json.loads(subprocess.run([args.recorder, "targets", "screens", "--json"],
                                        capture_output=True, text=True, timeout=60).stdout)
    start = subprocess.run([args.recorder, "record", "start", "--screen", str(screens[0]["id"]), "--mode", "studio",
                            "--path", project, "--json", "--detach"], capture_output=True, text=True, timeout=120)
    started = next(json.loads(l) for l in start.stdout.splitlines() if '"started"' in l)
    rid, pid = started["recordingId"], started["pid"]
    t0 = time.monotonic()
    time.sleep(10)
    suspend(pid, True)
    time.sleep(3)
    report = {"tag": args.tag, "status_before_export": meta_status(project)}
    report["export_during"] = run([args.exporter, "export", project, "--output",
                                   os.path.join(args.out, f"{args.tag}-during.mp4"), "--json"], 300)
    report["status_after_export"] = meta_status(project)
    suspend(pid, False)
    time.sleep(20)
    recorded = round(time.monotonic() - t0, 1)
    stop = subprocess.run([args.recorder, "record", "stop", "--id", rid, "--json", "--timeout", "300"],
                          capture_output=True, text=True, timeout=400)
    report["recorded_secs_before_stop"] = recorded
    report["stop"] = {"code": stop.returncode, "stdout": stop.stdout[-800:], "stderr": stop.stderr[-800:]}
    report["status_final"] = meta_status(project)
    report["validate_final"] = run([args.validator, "project", "validate", project, "--json"], 120)
    mp4 = os.path.join(args.out, f"{args.tag}-final.mp4")
    report["export_final"] = run([args.validator, "export", project, "--output", mp4, "--json",
                                  "--fps", "15", "--resolution", "640x360", "--quality", "potato"], 900)
    for name, path in (("during_duration", os.path.join(args.out, f"{args.tag}-during.mp4")), ("final_duration", mp4)):
        if os.path.exists(path):
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                               capture_output=True, text=True)
            report[name] = r.stdout.strip()
            os.remove(path)
    with open(os.path.join(args.out, f"{args.tag}.json"), "w") as f:
        json.dump(report, f, indent=1)
    print("FROZEN " + json.dumps({
        "tag": args.tag,
        "before": report["status_before_export"],
        "export_during": report["export_during"]["code"],
        "export_during_err": (report["export_during"].get("stderr") or "")[-160:],
        "during_duration": report.get("during_duration"),
        "after_export": report["status_after_export"],
        "recorded": recorded,
        "stop": report["stop"]["code"],
        "stop_err": report["stop"]["stderr"][-200:],
        "final": report["status_final"],
        "validate": report["validate_final"]["code"],
        "export_final": report["export_final"]["code"],
        "final_duration": report.get("final_duration"),
    }), flush=True)
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
