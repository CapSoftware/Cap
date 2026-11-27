import argparse, json, os, shutil, subprocess, sys, threading, time

MIB = 1024 * 1024
MAX_VOLUME = 16 * 1024 * MIB

try:
    import psutil
except ImportError:
    psutil = None


def free(path):
    return shutil.disk_usage(path).free


def guard_volume(volume):
    total = shutil.disk_usage(volume).total
    if total > MAX_VOLUME:
        sys.exit(f"refusing: {volume} is {total // MIB} MiB, not a small test volume")


def clean(volume):
    work = os.path.join(volume, "work")
    if os.path.exists(work):
        shutil.rmtree(work, ignore_errors=True)
    filler = os.path.join(volume, "filler")
    if os.path.exists(filler):
        os.remove(filler)
    os.makedirs(work, exist_ok=True)
    return work


def fill(volume, keep_mib):
    guard_volume(volume)
    target = keep_mib * MIB
    chunk = b"\0" * (16 * MIB)
    with open(os.path.join(volume, "filler"), "wb") as f:
        while True:
            left = free(volume) - target
            if left <= 0:
                break
            f.write(chunk[: min(len(chunk), left)])
            f.flush()
            os.fsync(f.fileno())
    return free(volume)


def run(cmd, timeout=900):
    t = time.monotonic()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"cmd": cmd[1:4], "code": p.returncode, "secs": round(time.monotonic() - t, 2),
                "stdout": p.stdout[-6000:], "stderr": p.stderr[-4000:]}
    except subprocess.TimeoutExpired:
        return {"cmd": cmd[1:4], "code": "timeout", "secs": timeout}


def screen_id(cap):
    out = subprocess.run([cap, "targets", "screens", "--json"], capture_output=True, text=True, timeout=60)
    screens = json.loads(out.stdout)
    return str(screens[0]["id"])


def probe(path):
    if not os.path.exists(path):
        return None
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
                        "-show_entries", "stream=nb_read_packets,width,height:format=duration",
                        "-of", "json", path], capture_output=True, text=True, timeout=600)
    info = json.loads(r.stdout or "{}")
    d = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "null", "-"],
                       capture_output=True, text=True, timeout=900)
    errs = [line for line in d.stderr.splitlines() if line.strip()]
    stream = (info.get("streams") or [{}])[0]
    return {"duration": float(info.get("format", {}).get("duration", 0) or 0),
            "packets": int(stream.get("nb_read_packets", 0) or 0),
            "size": f"{stream.get('width')}x{stream.get('height')}",
            "decode_errors": len(errs), "decode_error_head": errs[:3],
            "bytes": os.path.getsize(path)}


_children_cpu = [0.0]


def process_cpu(proc):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        times = [wintypes.FILETIME() for _ in range(4)]
        ok = ctypes.windll.kernel32.GetProcessTimes(int(proc._handle), *[ctypes.byref(t) for t in times])
        if not ok:
            return None
        to_s = lambda t: ((t.dwHighDateTime << 32) | t.dwLowDateTime) / 1e7
        return round(to_s(times[2]) + to_s(times[3]), 3)
    import resource
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    total = usage.ru_utime + usage.ru_stime
    delta = total - _children_cpu[0]
    _children_cpu[0] = total
    return round(delta, 3)


def box_at(data, kind):
    pos = 0
    while pos + 8 <= len(data):
        size = int.from_bytes(data[pos:pos + 4], "big")
        header = 8
        if size == 1:
            size = int.from_bytes(data[pos + 8:pos + 16], "big")
            header = 16
        elif size == 0:
            size = len(data) - pos
        if size < header:
            return None
        if data[pos + 4:pos + 8] == kind:
            return pos + header, size - header
        pos += size
    return None


def project_videos(project):
    found = []
    for root, _, files in os.walk(project):
        if ".recovery" in root:
            continue
        for name in files:
            if name == "display.mp4":
                info = probe(os.path.join(root, name))
                found.append({"path": os.path.relpath(os.path.join(root, name), project),
                              "duration": info["duration"], "packets": info["packets"],
                              "decode_errors": info["decode_errors"]})
    return found


def meta_status(project):
    try:
        with open(os.path.join(project, "recording-meta.json")) as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return None
    status = meta.get("status")
    if isinstance(status, dict):
        return status.get("status")
    return status if status else "complete-or-single"


def corrupt_fragments(project):
    count = 0
    for root, _, files in os.walk(project):
        for name in files:
            if not (name.startswith("segment_") and name.endswith(".m4s")):
                continue
            path = os.path.join(root, name)
            with open(path, "r+b") as f:
                data = f.read()
                found = box_at(data, b"mdat")
                if not found:
                    continue
                offset, length = found
                start = offset + length // 10
                span = min(max(512 * 1024, 0), length - length // 10)
                f.seek(start)
                f.write(b"\0" * span)
                count += 1
    return count


def tree_bytes(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


class Sampler(threading.Thread):
    def __init__(self, volume, pid):
        super().__init__(daemon=True)
        self.volume, self.pid, self.stop = volume, pid, False
        self.min_free, self.cpu, self.samples = None, 0.0, []
        self.proc = psutil.Process(pid) if psutil else None

    def run(self):
        start = time.monotonic()
        while not self.stop:
            f = free(self.volume)
            self.min_free = f if self.min_free is None else min(self.min_free, f)
            self.samples.append((round(time.monotonic() - start, 1), f // MIB))
            if self.proc:
                try:
                    procs = [self.proc] + self.proc.children(recursive=True)
                    self.cpu = max(self.cpu, sum(sum(p.cpu_times()[:2]) for p in procs))
                except Exception:
                    pass
            time.sleep(0.5)


def record(args):
    work = clean(args.volume)
    if args.start_free_mib:
        start_free = fill(args.volume, args.start_free_mib)
    else:
        start_free = free(args.volume)
    project = os.path.join(work, f"{args.tag}.cap")
    sid = screen_id(args.cap)
    cmd = [args.cap] + args.pre.split() + ["record", "start", "--screen", sid, "--mode", args.mode, "--path", project, "--json"] + args.post.split()
    if args.detach:
        cmd.append("--detach")
    else:
        cmd += ["--duration", str(args.duration)]
    if os.name != "nt":
        process_cpu(None)
    t0 = time.monotonic()
    stderr = open(os.path.join(args.out, f"{args.tag}.stderr.log"), "w")
    env = dict(os.environ)
    for item in args.env:
        key, _, value = item.partition("=")
        env[key] = value
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=stderr, text=True, env=env)
    sampler = Sampler(args.volume, proc.pid)
    sampler.start()
    events = []
    for line in proc.stdout:
        t = round(time.monotonic() - t0, 2)
        try:
            events.append({"t": t, **json.loads(line)})
        except ValueError:
            events.append({"t": t, "raw": line.strip()})
    try:
        code = proc.wait(timeout=args.duration + 600)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = "timeout"
    wall = round(time.monotonic() - t0, 2)
    exact_cpu = process_cpu(proc)
    report = {"tag": args.tag, "ref": args.ref, "mode": args.mode, "detach": args.detach,
              "start_free_mib": start_free // MIB, "duration_requested": args.duration,
              "exit": code, "wall": wall, "events": events}
    if args.detach and code == 0:
        rid = next((e.get("recordingId") for e in events if e.get("type") == "started"), None)
        final, seen_low = None, False
        deadline = time.monotonic() + args.duration
        while time.monotonic() < deadline:
            r = run([args.cap, "record", "status", "--json"], timeout=60)
            try:
                rows = [row for row in json.loads(r["stdout"]) if row.get("recordingId") == rid]
            except (ValueError, KeyError):
                rows = []
            if rows:
                seen_low = seen_low or rows[0].get("storageLow", False)
                if rows[0].get("status") != "recording":
                    final = rows[0]
                    break
            time.sleep(1)
        report["status_final"] = final
        report["status_saw_storage_low"] = seen_low
        stop_t = time.monotonic()
        stop = subprocess.run([args.cap, "record", "stop", "--id", rid, "--json", "--timeout", "300"],
                              capture_output=True, text=True, timeout=400)
        report["stop"] = {"code": stop.returncode, "secs": round(time.monotonic() - stop_t, 2),
                          "events": [json.loads(l) for l in stop.stdout.splitlines() if l.startswith("{")],
                          "stderr": stop.stderr[-2000:]}
        report["recorded_secs"] = round(stop_t - t0, 2)
    sampler.stop = True
    sampler.join()
    stderr.close()
    report["min_free_mib"] = (sampler.min_free or 0) // MIB
    report["end_free_mib"] = free(args.volume) // MIB
    report["cpu_secs"] = round(sampler.cpu, 2)
    report["exact_cpu_secs"] = exact_cpu
    report["free_trace"] = sampler.samples[::4]
    report["project_exists"] = os.path.exists(project)
    report["project_bytes"] = tree_bytes(project) if os.path.exists(project) else 0
    started = next((e["t"] for e in events if e.get("type") == "started"), None)
    stopped = next((e["t"] for e in events if e.get("type") == "stopped"), None)
    report["storage_events"] = [e for e in events if e.get("type") == "storage"]
    if started is not None and stopped is not None:
        report["started_to_stopped"] = round(stopped - started, 2)
    if report["project_exists"]:
        report["validate"] = run([args.cap, "project", "validate", project, "--json"], timeout=120)
        mp4 = os.path.join(args.out, f"{args.tag}.mp4")
        report["project_probe"] = project_videos(project)
        report["export"] = run([args.cap, "export", project, "--output", mp4, "--json"] + args.export_args.split(), timeout=900)
        report["export"]["stdout"] = report["export"].get("stdout", "")[-1500:]
        report["export_probe"] = probe(mp4)
        report["free_at_export_mib"] = free(args.volume) // MIB
        if os.path.exists(mp4):
            os.remove(mp4)
        if args.recover_cap:
            filler = os.path.join(args.volume, "filler")
            if os.path.exists(filler):
                os.remove(filler)
            if args.corrupt:
                report["corrupted_fragments"] = corrupt_fragments(project)
            if args.recover_copy_to:
                moved = os.path.join(args.recover_copy_to, os.path.basename(project))
                if os.path.exists(moved):
                    shutil.rmtree(moved, ignore_errors=True)
                shutil.copytree(project, moved)
                project = moved
            report["recover_free_mib"] = free(args.volume) // MIB
            report["recover_validate"] = run([args.recover_cap, "project", "validate", project, "--json"], timeout=300)
            report["recover_export"] = run([args.recover_cap, "export", project, "--output", mp4, "--json"] + args.export_args.split(), timeout=900)
            report["recover_project_probe"] = project_videos(project)
            report["recover_export"]["stdout"] = report["recover_export"].get("stdout", "")[-1500:]
            report["recover_probe"] = probe(mp4)
            report["recover_validate_after"] = run([args.recover_cap, "project", "validate", project, "--json"], timeout=300)
            if os.path.exists(mp4):
                os.remove(mp4)
    report["peak_used_mib"] = report["start_free_mib"] - report["min_free_mib"]
    with open(os.path.join(args.out, f"{args.tag}.json"), "w") as f:
        json.dump(report, f, indent=1)
    keys = ("tag", "exit", "wall", "start_free_mib", "min_free_mib", "free_at_export_mib",
            "project_bytes", "peak_used_mib", "started_to_stopped", "cpu_secs", "exact_cpu_secs")
    summary = {k: report.get(k) for k in keys}
    summary["events"] = [e.get("type") for e in events]
    summary["storage"] = [(e.get("t"), e.get("status"), (e.get("availableBytes") or 0) // MIB) for e in report["storage_events"]]
    summary["reason"] = next((e.get("reason") for e in events if e.get("type") == "stopped"), None)
    summary["error"] = next(((e.get("code"), e.get("error", "")[:160]) for e in events if e.get("type") == "error"), None)
    summary["validate"] = (report.get("validate") or {}).get("code")
    summary["export"] = (report.get("export") or {}).get("code")
    probe_result = report.get("export_probe") or {}
    summary["export_duration"] = probe_result.get("duration")
    summary["export_packets"] = probe_result.get("packets")
    summary["decode_errors"] = probe_result.get("decode_errors")
    if args.recover_cap:
        summary["recover_validate"] = (report.get("recover_validate") or {}).get("code")
        summary["recover_validate_out"] = (report.get("recover_validate") or {}).get("stdout", "")[-300:]
        summary["recover_export"] = (report.get("recover_export") or {}).get("code")
        summary["recover_export_err"] = ((report.get("recover_export") or {}).get("stderr") or "")[-300:]
        summary["recover_duration"] = (report.get("recover_probe") or {}).get("duration")
        summary["recover_decode_errors"] = (report.get("recover_probe") or {}).get("decode_errors")
        summary["recover_validate_after"] = (report.get("recover_validate_after") or {}).get("code")
        summary["recover_validate_after_out"] = ((report.get("recover_validate_after") or {}).get("stdout") or "")[-200:]
        summary["recover_export_out"] = ((report.get("recover_export") or {}).get("stdout") or "")[-300:]
        summary["corrupted_fragments"] = report.get("corrupted_fragments")
        summary["meta_status_after"] = meta_status(project)
    summary["project_videos"] = report.get("project_probe")
    if args.recover_cap:
        summary["recover_project_videos"] = report.get("recover_project_probe")
    summary["validate_out"] = ((report.get("validate") or {}).get("stdout") or "")[-300:]
    summary["export_err"] = ((report.get("export") or {}).get("stderr") or "")[-300:]
    if args.detach:
        summary["status_final"] = report.get("status_final")
        summary["stop_code"] = (report.get("stop") or {}).get("code")
        summary["stop_events"] = (report.get("stop") or {}).get("events")
        summary["status_saw_storage_low"] = report.get("status_saw_storage_low")
    print("SUMMARY " + json.dumps(summary), flush=True)
    clean(args.volume)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cap", required=True)
    p.add_argument("--ref", required=True)
    p.add_argument("--mode", required=True)
    p.add_argument("--volume", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--start-free-mib", type=int, default=0)
    p.add_argument("--duration", type=float, default=30)
    p.add_argument("--detach", action="store_true")
    p.add_argument("--pre", default="")
    p.add_argument("--post", default="")
    p.add_argument("--recover-cap", default="")
    p.add_argument("--env", action="append", default=[])
    p.add_argument("--corrupt", action="store_true")
    p.add_argument("--recover-copy-to", default="")
    p.add_argument("--export-args", default="")
    p.add_argument("--fill-mode", default="write")
    args = p.parse_args()
    os.makedirs(args.out, exist_ok=True)
    if args.start_free_mib:
        guard_volume(args.volume)
    record(args)


if __name__ == "__main__":
    main()
