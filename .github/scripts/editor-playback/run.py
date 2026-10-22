import os
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time

sys.stdout.reconfigure(line_buffering=True)

out_dir, rounds, sample_flag = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "sample"
specs = sys.argv[4:]
variants = [spec.split("=", 1) for spec in specs if spec.startswith("bin:")]
fixtures = [spec.split("=", 1) for spec in specs if spec.startswith("fix:")]
variants = [(name[4:], path) for name, path in variants]
fixtures = [(name[4:], path) for name, path in fixtures]
if only := os.environ.get("FIXTURES"):
    fixtures = [item for item in fixtures if item[0] in only.split()]
os.makedirs(out_dir, exist_ok=True)

draw = re.compile(r"timeline-bench: (\S+) ([\d.]+) mean / ([\d.]+) p50 / ([\d.]+) p95")
profile = re.compile(r"profile: (\S+) (.*)")
results = {}


def launch(binary, fixture, mode, label):
    data = tempfile.mkdtemp()
    env = dict(os.environ)
    env.update(
        CAP_GPUI_AUTO_EDITOR=fixture,
        CAP_GPUI_AUTO_TIMELINE_BENCH="1",
        CAP_GPUI_MUTE_AUDIO="1",
        CAP_GPUI_NO_MENUS="1",
        CAP_GPUI_NO_TRAY="1",
        CAP_PERF_SKIP_ONBOARDING="1",
        CAP_GPUI_APP_DATA_DIR=data,
        CAP_PROBE_ASSUME_ACTIVE="1",
        RUST_LOG=os.environ.get("RUST_LOG", "warn,cap_gpui=info"),
    )
    if mode == "profile":
        env["CAP_GPUI_AUTO_PROFILE"] = "1"
    stderr = open(os.path.join(out_dir, f"{label}.stderr.log"), "w")
    proc = subprocess.Popen([binary], env=env, stdout=subprocess.PIPE, stderr=stderr, text=True)
    killer = threading.Timer(600, proc.kill)
    killer.start()
    lines = []
    samplers = []
    for line in proc.stdout:
        line = line.rstrip("\n")
        lines.append(line)
        print(f"[{label}] {line}")
        if sample_flag and line.startswith("PROFILE-BEGIN "):
            _, phase, secs = line.split()
            seconds = max(1, int(float(secs)) - 1)
            path = os.path.join(out_dir, f"{label}-{phase}.sample.txt")
            samplers.append(
                subprocess.Popen(
                    ["sudo", "-n", "sample", str(proc.pid), str(seconds), "1", "-mayDie", "-file", path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.STDOUT,
                )
            )
    proc.wait()
    killer.cancel()
    for sampler in samplers:
        try:
            sampler.wait(timeout=60)
        except subprocess.TimeoutExpired:
            sampler.kill()
    with open(os.path.join(out_dir, f"{label}.stdout.log"), "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return proc.returncode, lines


for round_index in range(rounds):
    order = variants if round_index % 2 == 0 else list(reversed(variants))
    for fixture_name, fixture in fixtures:
        for variant, binary in order:
            for mode in os.environ.get("MODES", "bench profile").split():
                label = f"{variant}-{fixture_name}-{mode}-r{round_index + 1}"
                code, lines = launch(binary, fixture, mode, label)
                print(f"{label}: exit={code}")
                key = (fixture_name, variant)
                bucket = results.setdefault(key, {})
                for line in lines:
                    if match := draw.match(line):
                        bucket.setdefault(f"draw:{match[1]}:p50", []).append(float(match[3]))
                        bucket.setdefault(f"draw:{match[1]}:p95", []).append(float(match[4]))
                    if match := profile.match(line):
                        for field in match[2].split():
                            name, value = field.split("=", 1)
                            try:
                                bucket.setdefault(f"{match[1]}:{name}", []).append(float(value))
                            except ValueError:
                                pass

summary = ["| fixture | metric | " + " | ".join(name for name, _ in variants) + " |", "|---|---|" + "---|" * len(variants)]
for fixture_name, _ in fixtures:
    keys = []
    for variant, _ in variants:
        for key in results.get((fixture_name, variant), {}):
            if key not in keys:
                keys.append(key)
    for key in keys:
        cells = []
        for variant, _ in variants:
            values = results.get((fixture_name, variant), {}).get(key, [])
            cells.append(f"{statistics.median(values):.1f} (n={len(values)})" if values else "n/a")
        summary.append(f"| {fixture_name} | {key} | " + " | ".join(cells) + " |")
table = "\n".join(summary) + "\n"
print(table)
with open(os.path.join(out_dir, "summary.md"), "w") as handle:
    handle.write(table)
if path := os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(path, "a") as handle:
        handle.write(table)
