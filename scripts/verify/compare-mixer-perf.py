import collections
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time

root = Path(sys.argv[1])
fixtures = Path(os.environ["CAP_VERIFY_FIXTURE_DIR"])
workloads = [
    ("basic", "export", "export/basic/*"),
    ("jitter120", "export", "export/jitter-camera-120s/*"),
    ("storm30", "seek", "seek/*/storm30/*"),
    ("vfrstorm", "seek", "seek/vfr-holds/storm60/*"),
]
results = []
for name, target, pattern in workloads:
    for repeat in range(1, 9):
        outcomes = {}
        for arm in (["main", "candidate"] if repeat % 2 else ["candidate", "main"]):
            output = root / f"{name}-{repeat}-{arm}"
            output.mkdir()
            env = os.environ.copy()
            env.update(CAP_VERIFY_FIXTURE_DIR=str(fixtures), CAP_VERIFY_REPORT_DIR=str(output), CAP_VERIFY_CASE=pattern, CAP_VERIFY_TIER="full", CAP_VERIFY_HOST="blacksmith")
            binary = json.loads((root / f"{arm}-binaries.json").read_text())[target]
            started = time.monotonic()
            with (output / "test.log").open("w") as log:
                process = subprocess.run(["/usr/bin/time", "-l", binary, "--test-threads", "1", "--nocapture"], cwd="crates/verify", env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
            wall = time.monotonic() - started
            log = (output / "test.log").read_text()
            match = re.search(r"(\d+)\s+instructions retired", log)
            assert match and int(match.group(1)) > 0, output
            records = {}
            for file in output.glob("*.jsonl"):
                for line in file.read_text().splitlines():
                    row = json.loads(line)
                    records[row["case"]] = row["outcome"]
            assert records, output
            outcomes[arm] = records
            result = dict(workload=name, repeat=repeat, arm=arm, instructions=int(match.group(1)), wall=wall, returncode=process.returncode, outcomes=records)
            results.append(result)
            with (root / "results.jsonl").open("a") as stream:
                stream.write(json.dumps(result) + "\n")
            print(name, repeat, arm, result["instructions"], round(wall, 3), dict(collections.Counter(records.values())), flush=True)
            assert process.returncode == 0, output
        assert outcomes["main"] == outcomes["candidate"], (name, repeat, outcomes)
    summary = {}
    for metric in ["instructions", "wall"]:
        arms = {arm: [r[metric] for r in results if r["workload"] == name and r["arm"] == arm] for arm in ["main", "candidate"]}
        summary[metric] = {arm: {"min": min(values), "median": statistics.median(values), "max": max(values)} for arm, values in arms.items()}
        summary[metric]["median_delta_fraction"] = statistics.median(arms["candidate"]) / statistics.median(arms["main"]) - 1
    (root / f"{name}-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(name, json.dumps(summary), flush=True)
