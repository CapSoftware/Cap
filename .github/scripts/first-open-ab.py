import re, subprocess, sys, statistics, shutil, os
bench, fixture, iterations = sys.argv[1], sys.argv[2], int(sys.argv[3])
modes = {"cold": ["--shared-device"], "warm": ["--prewarm-renderer"]}
results = {m: {"open": [], "preview": [], "total": []} for m in modes}
for i in range(iterations):
    for mode, flags in modes.items():
        work = os.path.join(os.environ["RUNNER_TEMP"], f"fx-{mode}-{i}")
        shutil.rmtree(work, ignore_errors=True)
        shutil.copytree(fixture, work)
        out = subprocess.run([bench, "--recording-path", work, "--runs", "2", *flags], capture_output=True, text=True)
        print(f"--- {mode} iteration {i} exit={out.returncode}\n{out.stdout}{out.stderr[-2000:]}", flush=True)
        m = re.search(r"Run 1: ([0-9.]+)ms preview=([0-9.]+)ms", out.stdout)
        if not m or i == 0:
            continue
        o, p = float(m.group(1)), float(m.group(2))
        results[mode]["open"].append(o); results[mode]["preview"].append(p); results[mode]["total"].append(o + p)
lines = ["| mode | n | first open median ms | first preview median ms | open+preview median | min | max |", "|---|---|---|---|---|---|---|"]
for mode, r in results.items():
    if r["total"]:
        lines.append(f"| {mode} | {len(r['total'])} | {statistics.median(r['open']):.1f} | {statistics.median(r['preview']):.1f} | {statistics.median(r['total']):.1f} | {min(r['total']):.1f} | {max(r['total']):.1f} |")
table = "\n".join(lines)
print(table)
with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
    f.write("## First editor open in a fresh process (iteration 0 dropped)\n\n" + table + "\n")
