#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import time


STATUSES = {"PASS", "FAIL", "PENDING"}
RESERVE_BYTES = 2 * 1024**3
MAX_LOG_BYTES = 16 * 1024**2
UNTESTED = {
    "crash_recovery": "No owned process kill or fresh-process recovery was exercised.",
    "publication_faults": "No remux, write, rename or storage failure was injected.",
    "upload_restart": "No upload, restart, retry or remote playback was exercised.",
    "gui_editor": "CLI recording does not prove visible Start/Stop or editor auto-open.",
    "av_sync": "No independently measured visual/audio onset or drift stimulus.",
    "visual_content": "Frame counts do not prove moving, nonblack screen/camera content.",
    "stop_latency": "Foreground --duration does not expose the Stop request boundary.",
    "performance_parity": "Command lifetime is descriptive, not a Stop latency parity gate.",
    "export": "This initial clean-capture runner does not exercise export.",
}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("x", encoding="utf-8") as output:
        json.dump(value, output, indent=2, allow_nan=False)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def requirement(status, reason, **evidence):
    if status not in STATUSES:
        raise ValueError("Unknown requirement status")
    return {"status": status, "reason": reason, **evidence}


def aggregate(rows):
    values = [row["status"] for row in rows]
    if not values or any(value not in STATUSES for value in values):
        return "FAIL"
    if "FAIL" in values:
        return "FAIL"
    return "PENDING" if "PENDING" in values else "PASS"


def strict_json(text):
    def invalid_constant(value):
        raise ValueError(f"Invalid JSON numeric constant: {value}")

    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(text, parse_constant=invalid_constant, object_pairs_hook=unique_pairs)


def capture_events(text, project):
    events = [strict_json(line) for line in text.splitlines() if line.strip()]
    if not all(isinstance(event, dict) for event in events):
        raise ValueError("Recording JSONL contains a non-object")
    if any(event.get("type") == "error" or event.get("error") for event in events):
        raise ValueError("Recording emitted an error event")
    if [event.get("type") for event in events] != ["started", "stopped"]:
        raise ValueError("Expected exactly one started event followed by one stopped event")
    for event in events:
        if Path(event.get("path", "")).resolve() != project:
            raise ValueError("Recording event references a different project")
    if not events[0].get("recordingId") or not isinstance(events[0].get("pid"), int):
        raise ValueError("Started event has no recording identity")
    if events[1].get("recordingMetaExists") is not True:
        raise ValueError("Stopped event does not confirm saved metadata")
    return events


def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Missing or invalid media measurement") from error
    if not math.isfinite(number):
        raise ValueError("Non-finite media measurement")
    return number


def media_metrics(probe, expected_duration, fps, kind):
    streams = probe.get("streams", [])
    matching = [stream for stream in streams if stream.get("codec_type") == kind]
    if not matching:
        raise ValueError(f"Missing {kind} stream")
    measurements = []
    for stream in matching:
        duration = finite_number(stream.get("duration", probe.get("format", {}).get("duration")))
        frames = int(stream.get("nb_read_frames", "0"))
        tolerance = max(1.0, expected_duration * 0.1)
        if not expected_duration - tolerance <= duration <= expected_duration + 2:
            raise ValueError(f"{kind} duration {duration} does not match {expected_duration}s")
        if frames < 2:
            raise ValueError(f"{kind} stream has fewer than two decoded frames")
        if kind == "video":
            if int(stream.get("width", 0)) <= 0 or int(stream.get("height", 0)) <= 0:
                raise ValueError("Video has invalid dimensions")
            if frames / duration < fps * 0.8:
                raise ValueError("Video decoded cadence is below 80% of requested fps")
        measurements.append({"stream": stream, "durationSeconds": duration, "decodedFrames": frames})
    return measurements


def packet_timestamps(probe):
    streams = {stream["index"] for stream in probe.get("streams", []) if stream.get("codec_type") in {"video", "audio"}}
    previous, counts = {}, {}
    for packet in probe.get("packets", []):
        index = packet.get("stream_index")
        if index not in streams:
            continue
        dts, pts = packet.get("dts"), packet.get("pts")
        if type(dts) is not int or type(pts) is not int:
            raise ValueError("Media packet has no integer decode/presentation timestamp")
        if index in previous and dts <= previous[index]:
            raise ValueError("Input packet decode timestamps are not strictly increasing")
        previous[index] = dts
        counts[index] = counts.get(index, 0) + 1
    if not streams or set(counts) != streams:
        raise ValueError("Missing timestamped packets for a media stream")
    return counts


def audio_levels(stderr):
    levels = re.findall(r"RMS level dB:\s*(-?inf|[-+0-9.eE]+)", stderr)
    if not levels:
        raise ValueError("Audio analysis produced no RMS measurement")
    audible = [float(level) for level in levels if level not in {"inf", "-inf"}]
    if not audible or not all(math.isfinite(level) for level in audible) or max(audible) <= -60:
        raise ValueError("Requested audio is silent or below the -60 dBFS RMS floor")
    return {"maximumRmsDbfs": max(audible), "floorDbfs": -60}


def contained_file(path, project):
    supplied = Path(path)
    if not supplied.is_absolute():
        supplied = project / supplied
    resolved = supplied.resolve(strict=True)
    if not resolved.is_relative_to(project) or not resolved.is_file() or resolved.stat().st_size == 0:
        raise ValueError("Media must be a nonempty file inside the owned project")
    for part in [supplied, *supplied.parents]:
        if part == project.parent:
            break
        if part.is_symlink():
            raise ValueError("Project media may not traverse symbolic links")
    return resolved


def project_media(report, project, mode, camera, mic, system_audio):
    if report.get("valid") is not True or report.get("error") or report.get("problems") or report.get("missing"):
        raise ValueError("CLI project validation is not clean")
    if report.get("recordingType") != mode or Path(report.get("projectPath", "")).resolve() != project:
        raise ValueError("Project validation identity differs from the requested recording")
    checks = report.get("checks")
    if not isinstance(checks, list):
        raise ValueError("Project validation has no checks")
    roles = {"output": "video"} if mode == "instant" else {"displayVideo": "video"}
    if mode == "studio":
        roles.update({role: kind for role, kind, wanted in [
            ("camera", "video", camera), ("mic", "audio", mic), ("systemAudio", "audio", system_audio)
        ] if wanted})
    files = []
    for role, kind in roles.items():
        selected = [check for check in checks if check.get("role") == role and check.get("required") is True and check.get("exists") is True]
        if len(selected) != 1:
            raise ValueError(f"Expected exactly one required {role} track, found {len(selected)}")
        files.append({"role": role, "kind": kind, "path": str(contained_file(selected[0]["path"], project))})
    return files


WINDOWS_ADAPTER = r'''
param([string]$Request)
$ErrorActionPreference = "Stop"
$q = [IO.File]::ReadAllText($Request) | ConvertFrom-Json
$owned = $null
$r = [ordered]@{exitCode=$null;timedOut=$false;forcedCleanup=$false;cleanupComplete=$false;error=$null}
try {
    Add-Type -Path $q.source
    $owned = [CapOwnedProcess]::Start($q.binary,$q.arguments,$q.directory,$q.stdout,$q.stderr)
    $r.pid = $owned.Id
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not $owned.WaitForExit(100)) {
        if ($clock.Elapsed.TotalSeconds -ge $q.timeout) { $r.timedOut=$true; break }
        $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($q.directory))
        if ($drive.AvailableFreeSpace -lt $q.reserve) { throw "Storage reserve reached" }
        foreach ($path in @($q.stdout,$q.stderr)) {
            if ((Get-Item -LiteralPath $path).Length -gt $q.logLimit) { throw "Log limit reached" }
        }
    }
    $r.cleanupComplete = $owned.WaitForEmpty(2000)
    if (-not $r.cleanupComplete) {
        $r.forcedCleanup = $true
        $owned.TerminateOwnedTree()
        $r.cleanupComplete = $owned.WaitForEmpty(5000)
    }
    if ($owned.WaitForExit(1000)) { $r.exitCode = $owned.ExitCode }
    $r.activeAfterCleanup = $owned.ActiveProcesses
} catch { $r.error = [string]$_ } finally {
    if ($owned) {
        try { if ($owned.ActiveProcesses -ne 0) { $r.forcedCleanup=$true; $owned.TerminateOwnedTree(); $r.cleanupComplete=$owned.WaitForEmpty(5000) } }
        catch { $r.error = [string]$_; $r.cleanupComplete=$false }
        finally { $owned.Dispose() }
    }
    [IO.File]::WriteAllText($q.result,($r | ConvertTo-Json -Depth 5))
}
if ($r.error -or $r.timedOut -or $r.forcedCleanup -or -not $r.cleanupComplete -or $r.exitCode -ne 0) { exit 1 }
'''


class Runner:
    def __init__(self, root, deadline, binaries, windows_source=None):
        self.root = root
        self.deadline = deadline
        self.binaries = binaries
        self.windows_source = windows_source
        self.commands = []

    def run(self, name, arguments, timeout=90):
        if time.monotonic() >= self.deadline:
            raise RuntimeError("Run deadline reached; no further commands launched")
        if sha256(arguments[0]) != self.binaries[str(arguments[0])]:
            raise RuntimeError("An explicitly pinned executable changed")
        stdout, stderr = self.root / f"{name}.stdout", self.root / f"{name}.stderr"
        timeout = min(timeout, self.deadline - time.monotonic())
        start = time.monotonic_ns()
        env = dict(os.environ, CAP_NO_MODIFY_PATH="1")
        result = {"name": name, "arguments": list(map(str, arguments)), "stdout": str(stdout), "stderr": str(stderr)}
        if os.name == "nt":
            result.update(self.run_windows(name, arguments, stdout, stderr, timeout, env))
        else:
            with stdout.open("xb") as out, stderr.open("xb") as err:
                process = subprocess.Popen(arguments, cwd=self.root, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
                result.update(pid=process.pid, timedOut=False, forcedCleanup=False, cleanupComplete=False)
                try:
                    while process.poll() is None:
                        if (time.monotonic_ns() - start) / 1e9 >= timeout:
                            result["timedOut"] = True
                            break
                        if shutil.disk_usage(self.root).free < RESERVE_BYTES:
                            result["error"] = "Storage reserve reached"
                            break
                        if any(path.stat().st_size > MAX_LOG_BYTES for path in [stdout, stderr]):
                            result["error"] = "Command log limit reached"
                            break
                        time.sleep(0.05)
                finally:
                    try:
                        os.killpg(process.pid, 0)
                    except ProcessLookupError:
                        result["cleanupComplete"] = True
                    else:
                        result["forcedCleanup"] = True
                        os.killpg(process.pid, signal.SIGKILL)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        result["cleanupComplete"] = False
                    else:
                        try:
                            os.killpg(process.pid, 0)
                        except ProcessLookupError:
                            result["cleanupComplete"] = True
                result["exitCode"] = process.returncode
        result["commandLifetimeSeconds"] = (time.monotonic_ns() - start) / 1e9
        result["timingBoundary"] = "Command launch through observed exit and owned cleanup; not Stop latency"
        result["passed"] = result.get("exitCode") == 0 and result.get("cleanupComplete") is True and not result.get("timedOut") and not result.get("forcedCleanup") and not result.get("error")
        if any(path.exists() and path.stat().st_size > MAX_LOG_BYTES for path in [stdout, stderr]):
            result.update(passed=False, error="Command log exceeded the bounded parser limit")
        self.commands.append(result)
        write_json(self.root / f"{name}.command.json", result)
        if not result["passed"]:
            raise RuntimeError(f"Command failed or cleanup was incomplete: {name}")
        return stdout.read_text(encoding="utf-8", errors="strict"), stderr.read_text(encoding="utf-8", errors="replace")

    def run_windows(self, name, arguments, stdout, stderr, timeout, env):
        if not self.windows_source:
            raise RuntimeError("Windows requires --windows-job-source with the reviewed CapOwnedProcess launcher")
        if sha256(self.windows_source) != self.binaries[str(self.windows_source)]:
            raise RuntimeError("Windows process supervisor source changed")
        adapter = self.root / f"{name}.ps1"
        adapter.write_text(WINDOWS_ADAPTER, encoding="utf-8")
        request, receipt = self.root / f"{name}.request.json", self.root / f"{name}.job.json"
        write_json(request, {"source": str(self.windows_source), "binary": str(arguments[0]), "arguments": subprocess.list2cmdline(list(map(str, arguments[1:]))), "directory": str(self.root), "stdout": str(stdout), "stderr": str(stderr), "timeout": timeout, "result": str(receipt), "reserve": RESERVE_BYTES, "logLimit": MAX_LOG_BYTES})
        powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        with (self.root / f"{name}.supervisor.log").open("xb") as log:
            process = subprocess.Popen([str(powershell), "-NoProfile", "-NonInteractive", "-File", str(adapter), str(request)], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                process.wait(timeout=timeout + 30)
            except BaseException:
                process.kill()
                process.wait(timeout=5)
                raise
        if not receipt.is_file():
            raise RuntimeError("Windows supervisor produced no cleanup receipt")
        return strict_json(receipt.read_text(encoding="utf-8-sig"))


def checked_json(stdout, stderr):
    if re.search(r"\bERROR\b|^error:", stderr, re.MULTILINE):
        raise ValueError("CLI emitted an error log")
    value = strict_json(stdout)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def check_media(runner, args, prefix, media):
    path = Path(media["path"])
    before = sha256(path)
    write_json(runner.root / f"{prefix}-media-before.json", {**media, "bytes": path.stat().st_size, "sha256Before": before})
    stdout, stderr = runner.run(prefix + "-probe", [str(args.ffprobe), "-v", "error", "-count_frames", "-show_streams", "-show_format", "-show_packets", "-show_entries", "packet=stream_index,dts,pts:stream:format", "-of", "json", str(path)])
    if stderr.strip():
        raise ValueError("FFprobe emitted an error while counting decoded frames")
    probe = strict_json(stdout)
    metrics = media_metrics(probe, args.duration, args.fps, media["kind"])
    packets = packet_timestamps(probe)
    _, errors = runner.run(prefix + "-decode", [str(args.ffmpeg), "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode+crccheck", "-i", str(path), "-map", "0:v?", "-map", "0:a?", "-fps_mode", "passthrough", "-enc_time_base", "demux", "-f", "null", "-"], 120)
    if errors.strip():
        raise ValueError("Full decode emitted errors")
    audio = [stream for stream in probe["streams"] if stream.get("codec_type") == "audio"]
    needs_audio = media["kind"] == "audio" or (media["role"] == "output" and (args.mic or args.system_audio))
    levels = []
    if needs_audio:
        media_metrics(probe, args.duration, args.fps, "audio")
        for index in range(len(audio)):
            _, analysis = runner.run(prefix + f"-audio-{index}", [str(args.ffmpeg), "-hide_banner", "-v", "info", "-nostdin", "-xerror", "-i", str(path), "-map", f"0:a:{index}", "-af", "astats=metadata=0:reset=0", "-f", "null", "-"], 120)
            levels.append(audio_levels(analysis))
    after = sha256(path)
    if before != after:
        raise ValueError("Read-only media verification changed the artifact")
    return {**media, "bytes": path.stat().st_size, "sha256Before": before, "sha256After": after, "measurements": metrics, "packetCounts": packets, "audio": levels}


def run_case(runner, args, label, binary, head, mode):
    project = runner.root / f"{label}-{mode}.cap"
    row = {"label": label, "head": head, "mode": mode, "project": str(project), "requirements": {key: requirement("PENDING", reason) for key, reason in UNTESTED.items()}}
    for key in ["clean_local", "decodability", "requested_tracks"]:
        row["requirements"][key] = requirement("PENDING", "Not executed")
    try:
        if shutil.disk_usage(runner.root).free < RESERVE_BYTES + max(512 * 1024**2, int(args.duration * 8 * 1024**2)):
            raise RuntimeError("Insufficient free space above the 2 GiB reserve and capture allowance")
        health = checked_json(*runner.run(label + "-" + mode + "-doctor", [str(binary), "doctor", "--json"], 30))
        if health.get("captureReady") is not True or health.get("automations", {}).get("enabledCount") != 0:
            raise RuntimeError("Capture readiness or absence of recording-finished automations is unproved")
        command = [str(binary), "record", "start", "--mode", mode, "--path", str(project), "--duration", str(args.duration), "--fps", str(args.fps), "--json"]
        command.extend(["--window", args.window] if args.window else ["--screen", args.screen])
        for flag, value in [("--mic", args.mic), ("--camera", args.camera)]:
            if value:
                command.extend([flag, value])
        if args.system_audio:
            command.append("--system-audio")
        stdout, stderr = runner.run(label + "-" + mode + "-capture", command, args.duration + 90)
        if re.search(r"\bERROR\b|^error:", stderr, re.MULTILINE):
            raise ValueError("Recording emitted an error log")
        row["events"] = capture_events(stdout, project)
        report = checked_json(*runner.run(label + "-" + mode + "-validate", [str(binary), "project", "validate", str(project), "--json"], 30))
        files = project_media(report, project, mode, args.camera, args.mic, args.system_audio)
        row["requirements"]["clean_local"] = requirement("PASS", "Started/stopped events and project validation confirmed local completion")
        row["media"] = [check_media(runner, args, f"{label}-{mode}-{index}", media) for index, media in enumerate(files)]
        row["requirements"]["decodability"] = requirement("PASS", "Full decode, duration, decoded frame count and file identity checks passed")
        if mode == "instant" and (args.camera or (args.mic and args.system_audio)):
            row["requirements"]["requested_tracks"] = requirement("PENDING", "Composited camera or mixed audio requires an independent per-source stimulus oracle; encoded audio was still checked for non-silence")
        else:
            row["requirements"]["requested_tracks"] = requirement("PASS", "Requested separate tracks exist; requested audio passed non-silence checks")
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, subprocess.SubprocessError) as error:
        row["error"] = str(error)
        for key in ["clean_local", "decodability", "requested_tracks"]:
            if row["requirements"][key]["status"] == "PENDING":
                row["requirements"][key] = requirement("FAIL", str(error))
    row["status"] = aggregate(row["requirements"].values())
    write_json(runner.root / f"{label}-{mode}.json", row)
    return row


def arguments(argv=None):
    parser = argparse.ArgumentParser(description="Retained real-CLI recording evidence. Exit 0=all requirements PASS, 1=FAIL, 2=required coverage PENDING. No signing, upload, servers or library cleanup.")
    for flag in ["cap", "ffmpeg", "ffprobe", "root"]:
        parser.add_argument("--" + flag, required=True, type=Path)
    parser.add_argument("--head", required=True, help="Explicit source identity; recorded as an assertion, not inferred from the executable")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--window")
    target.add_argument("--screen")
    parser.add_argument("--mode", choices=["instant", "studio", "both"], default="both")
    parser.add_argument("--duration", type=float, default=12)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--mic")
    parser.add_argument("--camera")
    parser.add_argument("--system-audio", action="store_true")
    parser.add_argument("--baseline-cap", type=Path)
    parser.add_argument("--baseline-head")
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--budget-seconds", type=int, default=600)
    parser.add_argument("--windows-job-source", type=Path)
    args = parser.parse_args(argv)
    if not math.isfinite(args.duration) or not 3 <= args.duration <= 60 or not 1 <= args.fps <= 120:
        parser.error("Duration must be 3–60 seconds and fps 1–120")
    if not 1 <= args.iterations <= 3 or not 60 <= args.budget_seconds <= 1800:
        parser.error("Iterations must be 1–3 and total budget 60–1800 seconds")
    if bool(args.baseline_cap) != bool(args.baseline_head):
        parser.error("--baseline-cap and --baseline-head must be supplied together")
    if os.name == "nt" and not args.windows_job_source:
        parser.error("Windows requires an explicitly supplied reviewed --windows-job-source")
    return args


def main(argv=None):
    args = arguments(argv)
    root = args.root.absolute()
    if root.exists() or root.is_symlink() or not root.parent.is_dir() or root.parent.resolve() != root.parent:
        raise ValueError("--root must be a fresh absent directory under a real existing parent")
    identities = {}
    for field in ["cap", "baseline_cap", "ffmpeg", "ffprobe", "windows_job_source"]:
        path = getattr(args, field)
        if path:
            path = path.resolve(strict=True)
            if not path.is_file():
                raise ValueError(f"{field} must be an explicit file")
            setattr(args, field, path)
            identities[str(path)] = sha256(path)
    planned = []
    for iteration in range(args.iterations):
        builds = [("candidate", args.cap, args.head)]
        if args.baseline_cap:
            builds.insert(0, ("baseline", args.baseline_cap, args.baseline_head))
            if iteration % 2:
                builds.reverse()
        for name, binary, head in builds:
            for mode in (["studio", "instant"] if args.mode == "both" else [args.mode]):
                planned.append({"label": f"{iteration + 1}-{name}", "binary": str(binary), "head": head, "mode": mode})
    root.mkdir(mode=0o700)
    manifest = {"schemaVersion": 1, "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "platform": platform.platform(), "root": str(root), "candidateHeadAsserted": args.head, "baselineHeadAsserted": args.baseline_head, "binarySha256Before": identities, "plannedCases": planned, "requested": {"window": args.window, "screen": args.screen, "camera": args.camera, "mic": args.mic, "systemAudio": args.system_audio, "fps": args.fps, "durationSeconds": args.duration}, "sourceIdentityVerifiedByRunner": False, "packageProof": False}
    write_json(root / "manifest.json", manifest)
    runner = Runner(root, time.monotonic() + args.budget_seconds, identities, args.windows_job_source)
    rows = []
    try:
        for case in planned:
            rows.append(run_case(runner, args, case["label"], case["binary"], case["head"], case["mode"]))
            if time.monotonic() >= runner.deadline:
                raise RuntimeError("Run budget exhausted; remaining cases are unexecuted")
    except BaseException as error:
        rows.append({"status": "FAIL", "error": f"Runner interrupted: {error}"})
    completed = {(row.get("label"), row.get("mode")) for row in rows}
    for case in planned:
        if (case["label"], case["mode"]) not in completed:
            rows.append({**case, "status": "PENDING", "reason": "Planned case was not executed before interruption/deadline"})
    after = {}
    for path in identities:
        try:
            after[path] = sha256(path)
        except OSError:
            after[path] = None
    if after != identities:
        rows.append({"status": "FAIL", "error": "A pinned executable or supervisor source changed during the run"})
    summary = {**manifest, "binarySha256After": after, "status": aggregate(rows), "cases": rows, "commands": runner.commands, "recordingsRetained": True, "stopLatencyMeasured": False}
    write_json(root / "summary.json", summary)
    print(json.dumps({"status": summary["status"], "summary": str(root / "summary.json")}, allow_nan=False))
    return {"PASS": 0, "FAIL": 1, "PENDING": 2}[summary["status"]]


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"recording-reliability: {error}", file=sys.stderr)
        sys.exit(1)
