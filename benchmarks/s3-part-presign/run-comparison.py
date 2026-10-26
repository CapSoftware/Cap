import json
import os
import pathlib
import statistics
import subprocess

root = pathlib.Path(__file__).resolve().parent
rows = []
for case, megabytes, rtt in [("wan150", 60, 150), ("wan50", 60, 50), ("single150", 1, 150), ("single0", 1, 0)]:
    for repetition in range(1, 6):
        modes = ["baseline", "candidate"] if repetition % 2 else ["candidate", "baseline"]
        for mode in modes:
            env = dict(os.environ, PROOF_MB=str(megabytes), PROOF_RTT_MS=str(rtt))
            log = root / f"final-{case}-{repetition}-{mode}.log"
            assert not log.exists()
            with log.open("w") as stream:
                subprocess.run(
                    ["taskset", "-c", "0,1", str(root / f"release-{mode}-tests"), "multipart_tests::presign_latency_probe", "--exact", "--ignored", "--nocapture"],
                    env=env, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=60,
                )
            values = [json.loads(line.split(" ", 1)[1]) for line in log.read_text().splitlines() if line.startswith("PRESIGN_PROOF ")]
            assert len(values) == 1
            assert values[0]["connections"] >= 2
            assert values[0]["max_active_puts"] == 1
            assert values[0]["received_bytes"] == megabytes * 1_000_000
            rows.append(dict(values[0], case=case, repetition=repetition, mode=mode))
            (root / "final-samples.json").write_text(json.dumps(rows, indent=2) + "\n")
        print(case, repetition, "PASS", flush=True)
    summary = {
        c: {
            m: {
                "median_seconds": statistics.median(x["seconds"] for x in rows if x["case"] == c and x["mode"] == m),
                "min_seconds": min(x["seconds"] for x in rows if x["case"] == c and x["mode"] == m),
                "max_seconds": max(x["seconds"] for x in rows if x["case"] == c and x["mode"] == m),
            }
            for m in ["baseline", "candidate"]
        }
        for c in sorted({x["case"] for x in rows})
    }
    (root / "final-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary[case]), flush=True)
