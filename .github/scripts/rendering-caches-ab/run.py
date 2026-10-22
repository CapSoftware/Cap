import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

out = Path(sys.argv[1])
bins = Path(sys.argv[2])
fixtures = Path(sys.argv[3])
rounds = int(sys.argv[4])
frames = int(sys.argv[5])
out.mkdir(parents=True, exist_ok=True)
sides = ["base", "head"]
projects = {"cursor-wallpaper": fixtures / "cursor-wallpaper.cap", "effects": fixtures / "effects.cap"}
is_mac = platform.system() == "Darwin"
summary = []
log = open(out / "log.txt", "w")


def run(cmd, env=None, timeout=3600):
    started = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
    elapsed = time.monotonic() - started
    log.write(f"$ {' '.join(map(str, cmd))}\nexit {proc.returncode} in {elapsed:.2f}s\n{proc.stdout[-4000:]}\n{proc.stderr[-4000:]}\n")
    log.flush()
    return proc, elapsed


summary.append(f"## {platform.system()} {platform.machine()}\n")

summary.append("### per_frame_caches test (reused layers vs fresh layers)\n")
for side in sides:
    proc, elapsed = run([str(bins / side / "per_frame_caches"), "--nocapture", "--test-threads=1"])
    ok = proc.returncode == 0
    summary.append(f"- {side}: {'pass' if ok else 'FAIL'} ({elapsed:.1f}s)")
summary.append("")

results = {}
for round_index in range(rounds):
    for name, project in projects.items():
        for side in (sides if round_index % 2 == 0 else sides[::-1]):
            hashes = out / f"{name}-{side}.hashes" if round_index == 0 else ""
            proc, _ = run([str(bins / side / "per-frame-bench"), "bench", str(project), str(frames), str(hashes), f"{name}-{side}"])
            line = next((l for l in proc.stdout.splitlines() if l.startswith("{")), None)
            if line is None:
                summary.append(f"- bench {name} {side} round {round_index} FAILED")
                continue
            results.setdefault((name, side), []).append(json.loads(line))

summary.append(f"### Render CPU per frame ({frames} frames 1920x1080, median of {rounds} rounds, us)\n")
summary.append("| project | side | prepare | layer render | background prepare | cursor prepare | frame wall | bind groups/frame | buffers/frame |")
summary.append("|---|---|---|---|---|---|---|---|---|")


def med(values):
    values = sorted(values)
    return values[len(values) // 2]


for name in projects:
    for side in sides:
        rs = results.get((name, side), [])
        if not rs:
            continue
        row = [name, side]
        for key in ["prepare_us", "layer_render_us", "background_prepare_us", "cursor_prepare_us", "frame_wall_us"]:
            row.append(f"{med([r[key]['mean'] for r in rs]):.1f} (p50 {med([r[key]['p50'] for r in rs]):.1f})")
        row.append(f"{med([r['bind_groups_per_frame'] for r in rs]):.2f}")
        row.append(f"{med([r['buffers_per_frame'] for r in rs]):.2f}")
        summary.append("| " + " | ".join(row) + " |")
summary.append("")

summary.append("### Rendered frame identity (base vs head, per-frame hash of RGBA output)\n")
for name in projects:
    a, b = out / f"{name}-base.hashes", out / f"{name}-head.hashes"
    if a.exists() and b.exists():
        la, lb = a.read_text().splitlines(), b.read_text().splitlines()
        diff = sum(1 for x, y in zip(la, lb) if x != y) + abs(len(la) - len(lb))
        summary.append(f"- {name}: {len(la)} frames, {diff} differ")
summary.append("")

summary.append(f"### Wallpaper stat calls ({frames} frames + 10 warmup)\n")
for side in sides:
    project = projects["cursor-wallpaper"]
    wallpaper = project / "assets" / "cap-wallpaper.jpg"
    cmd = [str(bins / side / "per-frame-bench"), "bench", str(project), str(frames), "", f"stat-{side}"]
    if is_mac:
        env = dict(os.environ, DYLD_INSERT_LIBRARIES=str(bins / "interpose.dylib"), STAT_NEEDLE="cap-wallpaper")
        proc, _ = run(cmd, env=env)
        m = re.search(r"STAT_HITS (\d+)", proc.stderr)
        calls = int(m.group(1)) if m else None
    else:
        trace = out / f"strace-{side}.txt"
        proc, _ = run(["strace", "-f", "-qq", "-o", str(trace), "-P", str(wallpaper)] + cmd)
        lines = [l for l in trace.read_text().splitlines() if "cap-wallpaper" in l] if trace.exists() else []
        (out / f"strace-{side}-calls.txt").write_text("\n".join(sorted({re.sub(r"^\d+\s+", "", l).split("(")[0] for l in lines})) + "\n")
        calls = sum(1 for l in lines if re.search(r"\b(stat|lstat|newfstatat|statx|access|faccessat2?)\(", l))
    per_frame = f"{calls / (frames + 10):.3f}" if calls is not None else "n/a"
    summary.append(f"- {side}: {calls} calls, {per_frame} per frame")
summary.append("")

summary.append(f"### Export (export-cli mp4 1080p30 Web, 10 s project, {rounds} rounds alternating, wall s)\n")
settings = json.dumps({"fps": 30, "resolution_base": {"x": 1920, "y": 1080}, "compression": "Web", "custom_bpp": None})
exports = {}
ffmpeg = shutil.which("ffmpeg")
for round_index in range(rounds):
    for name, project in projects.items():
        for side in (sides if round_index % 2 == 0 else sides[::-1]):
            work = out / "work" / f"{name}-{side}.cap"
            if work.exists():
                shutil.rmtree(work)
            shutil.copytree(project, work)
            config = json.loads((work / "project-config.json").read_text())
            source = config["background"]["source"]
            if source.get("path"):
                source["path"] = str(work / "assets" / "cap-wallpaper.jpg")
            (work / "project-config.json").write_text(json.dumps(config))
            proc, elapsed = run([str(bins / side / "export-cli"), str(work), "mp4", settings])
            result = work / "output" / "result.mp4"
            if proc.returncode != 0 or not result.exists():
                summary.append(f"- export {name} {side} round {round_index} FAILED")
                continue
            exports.setdefault((name, side), []).append(elapsed)
            if round_index == 0 and ffmpeg:
                md5 = out / f"export-{name}-{side}.framemd5"
                subprocess.run([ffmpeg, "-v", "error", "-i", str(result), "-map", "0:v", "-f", "framemd5", str(md5)])
summary.append("| project | base | head |")
summary.append("|---|---|---|")
for name in projects:
    cells = [name]
    for side in sides:
        values = exports.get((name, side), [])
        cells.append(", ".join(f"{v:.2f}" for v in values) + (f" (median {med(values):.2f})" if values else ""))
    summary.append("| " + " | ".join(cells) + " |")
for name in projects:
    a, b = out / f"export-{name}-base.framemd5", out / f"export-{name}-head.framemd5"
    if a.exists() and b.exists():
        strip = lambda p: [l for l in p.read_text().splitlines() if not l.startswith("#")]
        la, lb = strip(a), strip(b)
        diff = sum(1 for x, y in zip(la, lb) if x != y) + abs(len(la) - len(lb))
        summary.append(f"- export {name}: {len(la)} frames, {diff} differ (framemd5)")
summary.append("")

text = "\n".join(summary) + "\n"
print(text)
(out / "summary.md").write_text(text)
step = os.environ.get("GITHUB_STEP_SUMMARY")
if step:
    with open(step, "a") as f:
        f.write(text)
