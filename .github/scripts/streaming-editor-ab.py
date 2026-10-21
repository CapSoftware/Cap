import os
import re
import statistics
import subprocess
import sys

binary, fixture, rounds, label = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
prefix = sys.argv[5:]

draw = re.compile(r"timeline-bench: (\S+) [\d.]+ mean / ([\d.]+) p50 / ([\d.]+) p95")
extra = re.compile(
    r"timeline-bench-ab: (\S+) presented=(\d+) rendered=(\d+) convert_avg_us=([\d.]+) "
    r"cpu_s=([\d.]+) wall_s=([\d.]+) cpu_pct=([\d.]+)"
)

results = {"0": [], "1": []}
for round_index in range(rounds):
    order = ["0", "1"] if round_index % 2 == 0 else ["1", "0"]
    for mode in order:
        env = dict(os.environ)
        env.update(
            CAP_GPUI_AUTO_EDITOR=fixture,
            CAP_GPUI_AUTO_TIMELINE_BENCH="1",
            CAP_GPUI_MUTE_AUDIO="1",
            CAP_GPUI_NO_MENUS="1",
            CAP_GPUI_NO_TRAY="1",
            CAP_GPUI_STREAMING_IMAGE=mode,
        )
        try:
            run = subprocess.run(
                prefix + [binary],
                env=env,
                capture_output=True,
                text=True,
                timeout=420,
            )
            out, code = run.stdout, run.returncode
            err = run.stderr
        except subprocess.TimeoutExpired as error:
            out = (error.stdout or b"").decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
            err = (error.stderr or b"").decode() if isinstance(error.stderr, bytes) else (error.stderr or "")
            code = "timeout"
        scenarios = {}
        for match in draw.finditer(out):
            scenarios.setdefault(match[1], {}).update(p50=float(match[2]), p95=float(match[3]))
        for match in extra.finditer(out):
            scenarios.setdefault(match[1], {}).update(
                presented=int(match[2]),
                rendered=int(match[3]),
                convert=float(match[4]),
                cpu_pct=float(match[7]),
            )
        print(f"round {round_index + 1} STREAMING_IMAGE={mode} exit={code}")
        print("\n".join(line for line in out.splitlines() if "timeline-bench" in line))
        if not scenarios:
            print("stderr tail:\n" + "\n".join(err.splitlines()[-40:]))
        results[mode].append(scenarios)
        sys.stdout.flush()

def median(mode, scenario, key):
    values = [run[scenario][key] for run in results[mode] if scenario in run and key in run[scenario]]
    return statistics.median(values) if values else None

lines = [
    f"### {label}",
    "",
    "| scenario | draw p50 µs (off → on) | draw p95 µs | convert avg µs | process CPU % | frames presented | runs |",
    "|---|---|---|---|---|---|---|",
]
scenario_names = []
for runs in results.values():
    for run in runs:
        for name in run:
            if name not in scenario_names:
                scenario_names.append(name)
fmt = lambda value, digits=0: "n/a" if value is None else f"{value:.{digits}f}"
for name in scenario_names:
    cells = []
    for key, digits in [("p50", 0), ("p95", 0), ("convert", 1), ("cpu_pct", 1), ("presented", 0)]:
        off, on = median("0", name, key), median("1", name, key)
        delta = ""
        if off and on is not None and key != "presented":
            delta = f" ({(on - off) / off * 100:+.0f}%)"
        cells.append(f"{fmt(off, digits)} → {fmt(on, digits)}{delta}")
    count = min(
        sum(1 for run in results["0"] if name in run),
        sum(1 for run in results["1"] if name in run),
    )
    lines.append(f"| {name} | " + " | ".join(cells) + f" | {count}/{rounds} |")
table = "\n".join(lines) + "\n"
print(table)
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as handle:
        handle.write(table + "\n")
