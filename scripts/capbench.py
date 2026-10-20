#!/usr/bin/env python3
"""Repeatable export / playback / decode / recording benchmarks for the Rust media pipeline.

Fixture: clone CapSoftware/cap-performance-fixtures into ./performance-fixtures (as CI does).
Build the measured binaries into target/perf (release codegen; see `profile.perf` below):

    cargo build --profile perf -p cap --bin cap -p cap-test --bin cap-test -p cap-editor \\
        --example playback-pipeline-benchmark --example decode-benchmark --example editor-startup-benchmark

`profile.perf` is not checked in; add it to .cargo/config.toml (or use --bin-dir target/release):

    [profile.perf]
    inherits = "release"
    codegen-units = 16
    lto = false

Then, e.g.:

    python scripts/capbench.py run offline --out bench/base
    python scripts/capbench.py run offline --variant base=bins/base --variant cand=bins/cand --out bench/ab
    python scripts/capbench.py run record --screen <id from `cap record screens`> --animate X,Y,W,H --out bench/rec
    python scripts/capbench.py compare bench/base/run.json bench/cand/run.json

On Windows each benchmark runs in a job object (whole-process-tree CPU time and peak commit)
at above-normal priority, so background load disturbs both variants less; absolute numbers are
therefore slightly optimistic. Variants are interleaved per repetition with alternating order,
each variant gets its own copy of the fixture, and comparisons report the median change with a
bootstrap 95% interval (verdicts need at least 5 runs per side).
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import platform
import random
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FIXTURE = ROOT / "performance-fixtures" / "reference-recording.cap"
EXE = ".exe" if os.name == "nt" else ""


class Job:
    def __init__(self, affinity=None):
        self.handle = None
        if os.name != "nt":
            return
        from ctypes import wintypes

        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        self.handle = self.kernel32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        limits = JobExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x20
        limits.BasicLimitInformation.PriorityClass = 0x8000
        if affinity:
            limits.BasicLimitInformation.LimitFlags |= 0x10
            limits.BasicLimitInformation.Affinity = affinity
        if not self.kernel32.SetInformationJobObject(
            wintypes.HANDLE(self.handle), 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

    def assign(self, process):
        if self.handle is None:
            return
        from ctypes import wintypes

        if not self.kernel32.AssignProcessToJobObject(
            wintypes.HANDLE(self.handle), wintypes.HANDLE(int(process._handle))
        ):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")

    def resume(self, process):
        if self.handle is None:
            return
        from ctypes import wintypes

        ntdll = ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        status = ntdll.NtResumeProcess(wintypes.HANDLE(int(process._handle)))
        if status != 0:
            raise OSError(status, "NtResumeProcess failed")

    def stats(self):
        if self.handle is None:
            return {}
        from ctypes import wintypes

        accounting = JobAccounting()
        limits = JobExtendedLimits()
        handle = wintypes.HANDLE(self.handle)
        self.kernel32.QueryInformationJobObject(
            handle, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None
        )
        self.kernel32.QueryInformationJobObject(
            handle, 9, ctypes.byref(limits), ctypes.sizeof(limits), None
        )
        return {
            "cpu_s": (accounting.TotalUserTime + accounting.TotalKernelTime) / 1e7,
            "peak_commit_mb": limits.PeakJobMemoryUsed / 2**20,
            "processes": accounting.TotalProcesses,
        }

    def close(self):
        if self.handle is not None:
            from ctypes import wintypes

            self.kernel32.CloseHandle(wintypes.HANDLE(self.handle))
            self.handle = None


if os.name == "nt":

    class JobBasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", ctypes.c_uint32),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", ctypes.c_uint32),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", ctypes.c_uint32),
            ("SchedulingClass", ctypes.c_uint32),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("r", "w", "o", "rb", "wb", "ob")]

    class JobExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JobBasicLimits),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class JobAccounting(ctypes.Structure):
        _fields_ = [
            ("TotalUserTime", ctypes.c_int64),
            ("TotalKernelTime", ctypes.c_int64),
            ("ThisPeriodTotalUserTime", ctypes.c_int64),
            ("ThisPeriodTotalKernelTime", ctypes.c_int64),
            ("TotalPageFaultCount", ctypes.c_uint32),
            ("TotalProcesses", ctypes.c_uint32),
            ("ActiveProcesses", ctypes.c_uint32),
            ("TotalTerminatedProcesses", ctypes.c_uint32),
        ]


CREATE_SUSPENDED = 0x4


def run_measured(argv, timeout, env=None, cwd=None, affinity=None):
    job = Job(affinity)
    started = time.perf_counter()
    # Started suspended so nothing it spawns can run before it is in the job.
    process = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_SUSPENDED if job.handle is not None else 0,
    )
    try:
        try:
            job.assign(process)
            job.resume(process)
        except BaseException:
            process.kill()
            process.wait()
            raise
        lines = []

        def pump():
            for line in process.stdout:
                lines.append((time.perf_counter() - started, line.rstrip("\n")))

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            code = "timeout"
        wall = time.perf_counter() - started
        reader.join(5)
        process.stdout.close()
        return {"exit": code, "wall_s": wall, **job.stats()}, lines
    finally:
        job.close()


def float_after(lines, pattern, group=1):
    regex = re.compile(pattern)
    for _, line in lines:
        match = regex.search(line)
        if match:
            return float(match.group(group))
    return None


def section_floats(lines, start_pattern, pattern, group=1):
    regex = re.compile(pattern)
    inside = False
    for _, line in lines:
        if re.search(start_pattern, line):
            inside = True
            continue
        if inside:
            match = regex.search(line)
            if match:
                return float(match.group(group))
    return None


def on_path(name):
    path = shutil.which(name)
    if path is None:
        raise FileNotFoundError(f"missing {name}; put it on PATH")
    return path


def ffprobe_video(path):
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0",
            "-show_entries", "stream=nb_read_packets,width,height:format=duration,size",
            "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise InvalidRun(f"ffprobe could not read {path.name}: {result.stderr.strip()[:200]}")
    data = json.loads(result.stdout)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format", {})
    if not int(stream.get("nb_read_packets", 0)):
        raise InvalidRun(f"ffprobe found no video frames in {path.name}")
    return {
        "out_frames": float(stream.get("nb_read_packets", 0)),
        "out_duration_s": float(fmt.get("duration", 0)),
        "out_size_mb": float(fmt.get("size", 0)) / 2**20,
        "out_width": float(stream.get("width", 0)),
        "out_height": float(stream.get("height", 0)),
    }


def parse_export(lines):
    progress = []
    for at, line in lines:
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "Progress":
            progress.append((at, event.get("rendered_count", 0), event.get("total_frames", 0)))
    rendering = [event for event in progress if event[1] > 0]
    if not rendering:
        return {}
    first_at, first_rendered, _ = rendering[0]
    last_at, rendered, total = rendering[-1]
    metrics = {"first_frame_s": first_at, "frames": float(total or rendered)}
    if last_at > first_at:
        metrics["steady_fps"] = (rendered - first_rendered) / (last_at - first_at)
    return metrics


def export_problem(probe, expected_frames, resolution):
    if not probe.get("out_frames"):
        return "export has no readable video frames"
    if expected_frames and probe["out_frames"] != expected_frames:
        return f"export has {probe['out_frames']:.0f} frames, expected {expected_frames:.0f}"
    max_width, max_height = (float(side) for side in resolution.split("x"))
    width, height = probe.get("out_width", 0), probe.get("out_height", 0)
    if not (0 < width <= max_width and 0 < height <= max_height):
        return f"export is {width:.0f}x{height:.0f}, outside {resolution}"
    return None


def export_bench(fps, resolution, quality, extra=()):
    def argv(ctx, out_dir):
        return [
            str(ctx.bin("cap")), "export", str(ctx.fixture), "-o", str(out_dir / "export.mp4"),
            "--fps", str(fps), "--resolution", resolution, "--quality", quality, "--json", *extra,
        ]

    def post(ctx, out_dir, metrics):
        probe = ffprobe_video(out_dir / "export.mp4")
        problem = export_problem(probe, metrics.get("frames"), resolution)
        if problem:
            raise InvalidRun(problem)
        metrics.update(probe)
        if metrics.get("frames") and metrics.get("wall_s"):
            metrics["export_fps"] = metrics["frames"] / metrics["wall_s"]
        return out_dir / "export.mp4"

    return {
        "argv": argv,
        "parse": parse_export,
        "post": post,
        "requires": lambda ctx: on_path("ffprobe"),
        "timeout": 900,
        "env": {"CAP_DISABLE_ENCODER_SELF_TEST": None},
        "better": {
            "wall_s": "lower", "cpu_s": "lower", "peak_commit_mb": "lower",
            "export_fps": "higher", "steady_fps": "higher", "first_frame_s": "lower",
        },
    }


def report_blocks(lines):
    blocks = {}
    block = stat = None
    texts = [line for _, line in lines]
    for index, line in enumerate(texts):
        stripped = line.strip()
        if index + 1 < len(texts) and set(texts[index - 1].strip()) == {"="} and set(texts[index + 1].strip()) == {"="}:
            block = blocks.setdefault(stripped, {})
            stat = None
            continue
        if block is None:
            continue
        fps = re.match(r"Effective FPS:\s*([\d.]+)", stripped)
        if fps:
            block["fps"] = float(fps.group(1))
        elif stripped.endswith(":") and not stripped.startswith(("avg", "p50")):
            stat = block.setdefault(stripped[:-1], {})
        elif stat is not None:
            for key, value in re.findall(r"(avg|p50|p95|p99)=([\d.]+)ms", stripped):
                stat[key] = float(value)
    return blocks


def parse_playback_pipeline(lines):
    blocks = report_blocks(lines)
    decode = blocks.get("DECODE-ONLY", {})
    full = blocks.get("FULL PIPELINE - Full (1920x1080)", {})
    scrub = blocks.get("SCRUBBING (Half resolution)", {})
    metrics = {
        "decode_fps": decode.get("fps"),
        "pipeline_fps": full.get("fps"),
        "render_p50_ms": full.get("GPU Render+Readback", {}).get("p50"),
        "pipeline_p95_ms": full.get("Total (decode+render)", {}).get("p95"),
        "scrub_decode_p50_ms": scrub.get("Decode", {}).get("p50"),
        "scrub_p50_ms": scrub.get("Total (decode+render)", {}).get("p50"),
        "scrub_p95_ms": scrub.get("Total (decode+render)", {}).get("p95"),
    }
    failed = sum(
        int(match.group(1))
        for _, line in lines
        if (match := re.match(r"(?:Decode|Render) failures:\s*(\d+)", line.strip()))
    )
    if failed:
        raise InvalidRun(f"playback-pipeline-benchmark reported {failed} failed frames")
    return {key: value for key, value in metrics.items() if value is not None}


def parse_decode(lines):
    metrics = {
        "decoder_create_ms": float_after(lines, r"Time to create decoder:\s*([\d.]+)ms"),
        "sequential_fps": section_floats(lines, r"SEQUENTIAL DECODE PERFORMANCE", r"Effective FPS:\s*([\d.]+)"),
        "random_avg_ms": float_after(lines, r"Avg access time:\s*([\d.]+)ms"),
        "random_p95_ms": section_floats(lines, r"RANDOM ACCESS PERFORMANCE", r"P95:\s*([\d.]+)ms"),
    }
    # Timings cover only the reads that succeeded, so a run with failed reads looks faster.
    failed = sum(
        int(match.group(2))
        for _, line in lines
        if (match := re.match(r"(Frames failed|Seek failures|Failures):\s*(\d+)", line.strip()))
    )
    if failed:
        raise InvalidRun(f"decode-benchmark reported {failed} failed reads")
    return {key: value for key, value in metrics.items() if value is not None}


def parse_startup(lines):
    metrics = {
        "startup_p50_ms": float_after(lines, r"^Startup: .*p50=([\d.]+)ms"),
        "first_preview_p50_ms": float_after(lines, r"^First preview: .*p50=([\d.]+)ms"),
    }
    return {key: value for key, value in metrics.items() if value is not None}


def example_bench(name, args, parse, better, timeout=600, env=None):
    def argv(ctx, out_dir):
        return [str(ctx.bin(name, example=True)), *args(ctx)]

    return {"argv": argv, "parse": parse, "timeout": timeout, "env": env or {}, "better": better}


class InvalidRun(Exception):
    pass


def validated_video(stdout, returncode):
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError:
        raise InvalidRun(f"cap-test validate exited {returncode} without a JSON report")
    if returncode != 0 or not report.get("valid"):
        raise InvalidRun("invalid recording: " + "; ".join(report.get("errors") or ["no errors reported"]))
    return report.get("video_info") or {}


def record_bench(mode, fps, seconds):
    def argv(ctx, out_dir):
        return [
            str(ctx.bin("cap")), "record", "--screen", ctx.screen, "--mode", mode,
            "--fps", str(fps), "--duration", str(seconds), "--path", str(out_dir / "rec.cap"),
        ]

    better = {
        "cpu_per_rec_s": "lower", "peak_commit_mb": "lower", "delivered_fps": "higher",
        "captured_ratio": "higher", "overhead_s": "lower",
    }
    if mode == "instant":
        # cap-test validate reports no frame count or duration for instant recordings.
        del better["delivered_fps"], better["captured_ratio"]

    def post(ctx, out_dir, metrics):
        project = out_dir / "rec.cap"
        validation = subprocess.run(
            [str(ctx.bin("cap-test")), "validate", str(project), "--json"],
            capture_output=True, text=True,
        )
        video = validated_video(validation.stdout, validation.returncode)
        frames = video.get("frame_count")
        captured = video.get("duration_secs")
        if frames and captured:
            metrics["frames"] = float(frames)
            metrics["captured_s"] = float(captured)
            metrics["captured_ratio"] = float(captured) / seconds
            metrics["delivered_fps"] = float(frames) / float(captured)
        if metrics.get("cpu_s") is not None:
            metrics["cpu_per_rec_s"] = metrics["cpu_s"] / seconds
        metrics["overhead_s"] = metrics["wall_s"] - seconds
        return None

    return {
        "argv": argv,
        "parse": lambda lines: {},
        "post": post,
        "requires": lambda ctx: ctx.bin("cap-test"),
        "timeout": seconds + 120,
        "env": {},
        "needs_screen": True,
        "better": better,
    }


BENCHES = {
    "export-1080p60": export_bench(60, "1920x1080", "maximum"),
    "export-4k60": export_bench(60, "3840x2160", "maximum"),
    "export-720p30": export_bench(30, "1280x720", "social"),
    # The editor decodes with FFmpeg on Windows (editor_instance.rs), so playback measures that path;
    # Media Foundation is covered by decode-display and the exports.
    "playback-pipeline": example_bench(
        "playback-pipeline-benchmark",
        lambda ctx: ["--recording-path", str(ctx.fixture), "--fps", "60", "--frames", "300", "--force-ffmpeg"],
        parse_playback_pipeline,
        {
            "cpu_s": "lower", "decode_fps": "higher", "pipeline_fps": "higher", "render_p50_ms": "lower",
            "pipeline_p95_ms": "lower", "scrub_decode_p50_ms": "lower", "scrub_p50_ms": "lower",
            "scrub_p95_ms": "lower",
        },
    ),
    "playback-pipeline-1ms": example_bench(
        "playback-pipeline-benchmark",
        lambda ctx: ["--recording-path", str(ctx.fixture), "--fps", "60", "--frames", "300", "--force-ffmpeg", "--timer-1ms"],
        parse_playback_pipeline,
        {
            "cpu_s": "lower", "decode_fps": "higher", "pipeline_fps": "higher", "render_p50_ms": "lower",
            "pipeline_p95_ms": "lower", "scrub_decode_p50_ms": "lower", "scrub_p50_ms": "lower",
            "scrub_p95_ms": "lower",
        },
    ),
    "decode-display": example_bench(
        "decode-benchmark",
        lambda ctx: [
            "--video", str(ctx.fixture / "content" / "segments" / "segment-0" / "display.mp4"),
            "--fps", "60", "--iterations", "50",
        ],
        parse_decode,
        {"cpu_s": "lower", "sequential_fps": "higher", "random_avg_ms": "lower", "random_p95_ms": "lower", "decoder_create_ms": "lower"},
    ),
    "editor-startup": example_bench(
        "editor-startup-benchmark",
        lambda ctx: ["--recording-path", str(ctx.fixture), "--runs", "3"],
        parse_startup,
        {"startup_p50_ms": "lower", "first_preview_p50_ms": "lower"},
    ),
    "record-studio-60": record_bench("studio", 60, 10),
    "record-instant-30": record_bench("instant", 30, 10),
}

SUITES = {
    "quick": ["export-1080p60", "playback-pipeline"],
    "export": ["export-1080p60", "export-4k60", "export-720p30"],
    "playback": ["playback-pipeline", "playback-pipeline-1ms", "decode-display", "editor-startup"],
    "record": ["record-studio-60", "record-instant-30"],
    "offline": ["export-1080p60", "export-4k60", "export-720p30", "playback-pipeline", "decode-display", "editor-startup"],
}
SUITES["all"] = SUITES["offline"] + SUITES["record"]


class Context:
    def __init__(self, args):
        self.source_fixture = Path(args.fixture).resolve()
        self.fixture = self.source_fixture
        self.bin_dir = Path(args.bin_dir).resolve()
        self.screen = args.screen
        self.animate = args.animate
        self.affinity = int(args.affinity, 0) if args.affinity else None
        self.extra_env = {}

    def bin(self, name, example=False):
        path = self.bin_dir / ("examples" if example else "") / f"{name}{EXE}"
        if not path.exists():
            raise FileNotFoundError(f"missing binary {path}; build it with --profile perf first")
        return path


def bench_env(spec, ctx):
    env = dict(os.environ)
    env["PATH"] = str(ctx.bin_dir) + os.pathsep + env.get("PATH", "")
    for key, value in spec.get("env", {}).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    env.update(ctx.extra_env)
    return env


def start_animation(bounds):
    x, y, width, height = bounds.split(",")
    process = subprocess.Popen(
        ["ffplay", "-hide_banner", "-loglevel", "quiet", "-noborder", "-alwaysontop",
         "-left", x, "-top", y, "-x", width, "-y", height,
         "-f", "lavfi", f"testsrc2=s={width}x{height}:r=60"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    return process


# Job accounting, and the metrics derived from it, exist only where the job object does (Windows).
JOB_METRICS = {"cpu_s", "peak_commit_mb", "cpu_per_rec_s"}


def missing_metrics(better, metrics):
    optional = set() if "cpu_s" in metrics else JOB_METRICS
    return sorted(key for key in better if key not in metrics and key not in optional)


def run_once(name, spec, ctx, out_dir, keep_log):
    out_dir.mkdir(parents=True, exist_ok=True)
    argv = spec["argv"](ctx, out_dir)
    animation = start_animation(ctx.animate) if spec.get("needs_screen") and ctx.animate else None
    try:
        measured, lines = run_measured(argv, spec["timeout"], env=bench_env(spec, ctx), cwd=out_dir, affinity=ctx.affinity)
    finally:
        if animation:
            animation.kill()
            animation.wait()
    metrics = {key: value for key, value in measured.items() if key != "exit"}
    artifact = None
    code = measured["exit"]
    try:
        metrics.update(spec["parse"](lines))
        if code == 0 and spec.get("post"):
            artifact = spec["post"](ctx, out_dir, metrics)
    except InvalidRun as error:
        code = "invalid" if code == 0 else code
        lines.append((measured["wall_s"], f"capbench: {error}"))
    missing = missing_metrics(spec["better"], metrics)
    if code == 0 and missing:
        code = "invalid"
        lines.append((measured["wall_s"], f"capbench: no {', '.join(missing)} in this run's output"))
    if keep_log or code != 0:
        (out_dir / "output.log").write_text("\n".join(line for _, line in lines), encoding="utf-8")
    return code, metrics, artifact


def build_info(bin_dir):
    path = bin_dir / "build-info.txt"
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


def runner_git_info():
    def git(*args):
        result = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)
        return result.stdout.strip()

    return {"commit": git("rev-parse", "HEAD"), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(git("status", "--porcelain", "--untracked-files=no"))}


def parse_variant_env(labels, items):
    env = {label: {} for label in labels}
    for item in items:
        label, _, assignment = item.partition(":")
        key, _, value = assignment.partition("=")
        if label not in env or not key:
            sys.exit(f"--env expects LABEL:KEY=VALUE with a known variant label, got {item!r}")
        env[label][key] = value
    return env


def cmd_run(args):
    ctx = Context(args)
    names = []
    for item in args.bench:
        names.extend(SUITES.get(item, [item]))
    unknown = [name for name in names if name not in BENCHES]
    if unknown:
        sys.exit(f"unknown benchmark(s): {', '.join(unknown)}. Known: {', '.join(BENCHES)}; suites: {', '.join(SUITES)}")
    if any(BENCHES[name].get("needs_screen") for name in names) and not ctx.screen:
        sys.exit("recording benchmarks need --screen <id> (see `cap record screens`)")
    if not ctx.source_fixture.exists():
        sys.exit(f"fixture not found: {ctx.source_fixture}")

    if any("=" not in item for item in args.variant):
        sys.exit("--variant expects LABEL=BIN_DIR")
    variants = [tuple(item.split("=", 1)) for item in args.variant] or [(args.label, args.bin_dir)]
    if len({label for label, _ in variants}) != len(variants):
        sys.exit("variant labels must be unique")
    for label, _ in variants:
        if label in ("", ".", "..") or Path(label).name != label:
            sys.exit(f"label {label!r} must be a plain file name; results are written to <out>/<label>.json")
    variant_env = parse_variant_env([label for label, _ in variants], args.env)

    out_root = Path(args.out).resolve()
    work = out_root / "work"
    if ctx.source_fixture.is_relative_to(work) or work.is_relative_to(ctx.source_fixture):
        sys.exit(f"--fixture {ctx.source_fixture} and the work directory {work} overlap; the work directory is deleted before each run")
    for label, bin_dir in variants:
        if Path(bin_dir).resolve().is_relative_to(work):
            sys.exit(f"binaries for {label} ({bin_dir}) are inside the work directory {work}, which is deleted before each run")
    for _, bin_dir in variants:
        ctx.bin_dir = Path(bin_dir).resolve()
        try:
            for name in names:
                BENCHES[name]["argv"](ctx, work)
                BENCHES[name].get("requires", lambda ctx: None)(ctx)
        except FileNotFoundError as error:
            sys.exit(str(error))
    if work.exists():
        shutil.rmtree(work)
    # Exports migrate the project config in place, so variants must not share a fixture.
    fixtures = {}
    for label, _ in variants:
        fixtures[label] = work / "fixture" / label / ctx.source_fixture.name
        shutil.copytree(ctx.source_fixture, fixtures[label], ignore=shutil.ignore_patterns(".git", ".recovery.lock"))
    all_results = {}
    for label, bin_dir in variants:
        ctx.bin_dir = Path(bin_dir).resolve()
        all_results[label] = {
            "meta": {
                "label": label, "runner_git": runner_git_info(), "fixture": str(ctx.source_fixture),
                "bin_dir": str(ctx.bin_dir), "build_info": build_info(ctx.bin_dir), "env": variant_env[label],
                "machine": platform.platform(), "cpu": platform.processor(),
                "reps": args.reps, "warmup": args.warmup, "affinity": args.affinity,
                "interleaved_with": [other for other, _ in variants if other != label],
                "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
            },
            "benches": {name: {"runs": [], "failures": [], "better": BENCHES[name]["better"]} for name in names},
        }

    # Logs are written inside work, which is deleted at the end unless --keep-work.
    def save_log(kind, label, name, run, out_dir):
        log = out_root / kind / label / name / f"{run}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out_dir / "output.log", log)
        return log

    schedule = [("warmup", rep) for rep in range(args.warmup)] + [("rep", rep) for rep in range(args.reps)]
    for phase, rep in schedule:
        for name in names:
            spec = BENCHES[name]
            for label, bin_dir in variants if rep % 2 == 0 else variants[::-1]:
                ctx.bin_dir = Path(bin_dir).resolve()
                ctx.fixture = fixtures[label]
                ctx.extra_env = variant_env[label]
                results = all_results[label]
                out_dir = work / label / name / f"{phase}{rep}"
                code, metrics, artifact = run_once(name, spec, ctx, out_dir, args.keep_logs)
                status = "ok" if code == 0 else f"exit={code}"
                summary = ", ".join(f"{key}={value:.3f}" for key, value in sorted(metrics.items()) if key in spec["better"])
                print(f"[{phase} {rep}] {label} {name}: {status} {summary}", flush=True)
                if phase == "warmup":
                    continue
                if code != 0:
                    log = save_log("failures", label, name, f"{phase}{rep}", out_dir)
                    results["benches"][name]["failures"].append({"rep": rep, "exit": code, "log": str(log)})
                    continue
                results["benches"][name]["runs"].append(metrics)
                if args.keep_logs:
                    save_log("logs", label, name, f"{phase}{rep}", out_dir)
                if artifact and args.keep_outputs:
                    kept = out_root / "artifacts" / label / f"{name}{artifact.suffix}"
                    kept.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(artifact, kept)
                    results["benches"][name]["artifact"] = str(kept)

    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    out_root.mkdir(parents=True, exist_ok=True)
    for label, results in all_results.items():
        for bench in results["benches"].values():
            bench["median"] = summarize(bench["runs"])
        path = out_root / f"{label}.json"
        path.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"\n=== {label} ===")
        print_table(results)
        print(f"\nresults: {path}")
    if len(variants) == 2:
        print()
        print_comparison(all_results[variants[0][0]], all_results[variants[1][0]])
    if any(bench["failures"] for results in all_results.values() for bench in results["benches"].values()):
        sys.exit(1)


def summarize(runs):
    keys = sorted({key for run in runs for key in run})
    return {key: statistics.median([run[key] for run in runs if key in run]) for key in keys}


def spread(values):
    if len(values) < 2:
        return 0.0
    center = statistics.median(values)
    return statistics.median([abs(value - center) for value in values]) / center * 100 if center else 0.0


def print_table(results):
    for name, bench in results["benches"].items():
        print(f"\n{name}  (n={len(bench['runs'])}, failures={len(bench['failures'])})")
        for key, direction in bench["better"].items():
            values = [run[key] for run in bench["runs"] if key in run]
            if values:
                print(f"  {key:<20} {statistics.median(values):>12.3f}  +/-{spread(values):4.1f}% MAD  ({direction} is better)")


def bootstrap_ratio_ci(base, cand, rounds=4000, seed=0):
    rng = random.Random(seed)
    ratios = []
    for _ in range(rounds):
        b = statistics.median(rng.choices(base, k=len(base)))
        c = statistics.median(rng.choices(cand, k=len(cand)))
        if b:
            ratios.append(c / b)
    ratios.sort()
    if not ratios:
        return None
    return ratios[int(0.025 * len(ratios))], ratios[int(0.975 * len(ratios)) - 1]


def compare(base, cand):
    rows = []
    for name, cand_bench in cand["benches"].items():
        base_bench = base["benches"].get(name)
        if not base_bench:
            continue
        for key, direction in cand_bench["better"].items():
            b = [run[key] for run in base_bench["runs"] if key in run]
            c = [run[key] for run in cand_bench["runs"] if key in run]
            if not b or not c or statistics.median(b) == 0:
                continue
            change = statistics.median(c) / statistics.median(b) - 1
            ci = bootstrap_ratio_ci(b, c)
            significant = ci is not None and (ci[0] > 1 or ci[1] < 1)
            improved = (change < 0) == (direction == "lower")
            verdict = "same"
            if min(len(b), len(c)) < 5:
                verdict = "n<5"
            elif significant:
                verdict = "BETTER" if improved else "WORSE"
            rows.append({
                "bench": name, "metric": key, "base": statistics.median(b), "cand": statistics.median(c),
                "change_pct": change * 100,
                "ci_pct": None if ci is None else [(ci[0] - 1) * 100, (ci[1] - 1) * 100],
                "verdict": verdict,
            })
    return rows


def ssim(reference, distorted):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(distorted), "-i", str(reference),
         "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    match = re.search(r"All:([\d.]+)", result.stderr)
    return float(match.group(1)) if match else None


def cmd_compare(args):
    base = json.loads(Path(args.base).read_text(encoding="utf-8"))
    cand = json.loads(Path(args.cand).read_text(encoding="utf-8"))
    rows = print_comparison(base, cand)
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=2), encoding="utf-8")


def print_comparison(base, cand):
    rows = compare(base, cand)
    def build(meta):
        return (meta.get("build_info") or meta["bin_dir"]).splitlines()[0]

    print(f"base: {base['meta']['label']} ({build(base['meta'])})")
    print(f"cand: {cand['meta']['label']} ({build(cand['meta'])})")
    current = None
    for row in rows:
        if row["bench"] != current:
            current = row["bench"]
            print(f"\n{current}")
        ci = row["ci_pct"]
        ci_text = "" if ci is None else f"[{ci[0]:+6.1f}%, {ci[1]:+6.1f}%]"
        print(f"  {row['metric']:<20} {row['base']:>11.3f} -> {row['cand']:>11.3f}  "
              f"{row['change_pct']:+7.1f}%  {ci_text:<20} {row['verdict']}")
    for name, cand_bench in cand["benches"].items():
        base_artifact = base["benches"].get(name, {}).get("artifact")
        cand_artifact = cand_bench.get("artifact")
        if base_artifact and cand_artifact and Path(base_artifact).exists() and Path(cand_artifact).exists():
            print(f"\n{name} output SSIM vs base: {ssim(base_artifact, cand_artifact)}")
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description="Repeatable Cap performance benchmarks (export, playback, decode, recording).")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run benchmarks and write results.json")
    run.add_argument("bench", nargs="+", help=f"benchmarks or suites: {', '.join(list(SUITES) + list(BENCHES))}")
    run.add_argument("--out", required=True, help="directory for results.json and artifacts")
    run.add_argument("--label", default="run")
    run.add_argument("--reps", type=int, default=5)
    run.add_argument("--warmup", type=int, default=1)
    run.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    run.add_argument("--bin-dir", default=str(ROOT / "target" / "perf"))
    run.add_argument("--variant", action="append", default=[], metavar="LABEL=BIN_DIR",
                     help="benchmark several builds interleaved in one session (repeatable); overrides --label/--bin-dir")
    run.add_argument("--env", action="append", default=[], metavar="LABEL:KEY=VALUE",
                     help="extra environment variable for one variant (repeatable), for A/B testing runtime knobs")
    run.add_argument("--screen", help="screen id for recording benchmarks")
    run.add_argument("--animate", metavar="X,Y,W,H", help="play a 60fps ffplay test pattern over these screen bounds during recording benchmarks")
    run.add_argument("--affinity", help="CPU affinity mask for benchmark processes, e.g. 0xFFFF for the first 16 logical CPUs")
    run.add_argument("--keep-outputs", action="store_true", help="keep one export per bench for SSIM comparison")
    run.add_argument("--keep-logs", action="store_true")
    run.add_argument("--keep-work", action="store_true")
    run.set_defaults(func=cmd_run)

    cmp = sub.add_parser("compare", help="compare two results.json files")
    cmp.add_argument("base")
    cmp.add_argument("cand")
    cmp.add_argument("--json")
    cmp.set_defaults(func=cmd_compare)

    sub.add_parser("list", help="list benchmarks and suites").set_defaults(
        func=lambda _: print("\n".join([*(f"suite {k}: {' '.join(v)}" for k, v in SUITES.items()), *BENCHES]))
    )

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
