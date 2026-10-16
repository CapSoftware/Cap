import json
import os
from pathlib import Path
import shutil
import subprocess
import time

root = Path.cwd()
output = Path(os.environ["RUNNER_TEMP"]) / "crash-retention"
output.mkdir(parents=True, exist_ok=True)
hosted = os.environ.get("RETENTION_HOSTED") == "1"
branches = {
    "control": "scratch/sol-crash-control-20261016",
    "2640": "ci/fixproof-2640-sol",
    "2642": "ci/fixproof-2642-sol",
}
if hosted:
    branches = {"control": branches["control"]}
binaries = {}
heads = {}
for arm, branch in branches.items():
    subprocess.run(["git", "fetch", "origin", branch], check=True, stdout=subprocess.DEVNULL)
    head = subprocess.check_output(["git", "rev-parse", "FETCH_HEAD"], text=True).strip()
    subprocess.run(["git", "checkout", "--detach", head], check=True, stdout=subprocess.DEVNULL)
    heads[arm] = head
    build_dir = output / "build" / arm
    build_dir.mkdir(parents=True)
    (build_dir / "head.txt").write_text(head + "\n")
    shutil.copyfile(root / "crates/verify/expectations.toml", build_dir / "expectations.toml")
    with (build_dir / "build.jsonl").open("w") as stdout, (build_dir / "build.log").open("w") as stderr:
        result = subprocess.run([
            "cargo", "test", "--profile", "ci-verify", "--locked", "-p", "cap-verify",
            "--test", "crash", "--no-run", "--message-format=json",
        ], stdout=stdout, stderr=stderr)
    if result.returncode:
        print(f"{arm}: build failed; retained build.log", flush=True)
        raise SystemExit(result.returncode)
    artifacts = [json.loads(line) for line in (build_dir / "build.jsonl").read_text().splitlines()]
    executables = [row["executable"] for row in artifacts if row.get("reason") == "compiler-artifact" and row.get("executable") and row.get("target", {}).get("name") == "crash"]
    assert len(executables) == 1, executables
    binary_dir = Path(os.environ["RUNNER_TEMP"]) / "crash-retention-bin" / arm
    binary_dir.mkdir(parents=True)
    shutil.copy2(executables[0], binary_dir / "crash")
    with (build_dir / "muxer-build.log").open("w") as log:
        subprocess.run(["cargo", "build", "--profile", "ci-verify", "--locked", "-p", "cap-muxer"], check=True, stdout=log, stderr=subprocess.STDOUT)
    shutil.copy2(root / "target/ci-verify/cap-muxer", binary_dir / "cap-muxer")
    binaries[arm] = binary_dir
    print(f"built {arm} {head}", flush=True)
(output / "heads.json").write_text(json.dumps(heads, indent=2))
results = []
for repeat in range(1, 2 if hosted else 7):
    for arm in branches:
        case_dir = output / f"repeat-{repeat}" / arm
        case_dir.mkdir(parents=True)
        shutil.copyfile(output / "build" / arm / "expectations.toml", root / "crates/verify/expectations.toml")
        env = os.environ.copy()
        env.update({
            "CAP_VERIFY_KEEP": "1",
            "CAP_VERIFY_SCRATCH": str(case_dir / "raw"),
            "CAP_VERIFY_REPORT_DIR": str(case_dir / "report"),
            "CAP_VERIFY_TIER": "full",
            "CAP_VERIFY_CASE": "crash/equality,crash/recorder-kill/*/finalize+40ms",
            "CAP_VERIFY_LOG": "cap_recording=info,cap_enc_ffmpeg=debug",
            "CAP_VERIFY_HOST": "github-hosted" if hosted else "blacksmith",
            "CAP_MUXER_BIN": str(binaries[arm] / "cap-muxer"),
        })
        started = time.monotonic()
        with (case_dir / "execution.log").open("w") as log:
            result = subprocess.run([str(binaries[arm] / "crash"), "--exact", "crash_safety", "--nocapture", "--test-threads=1"], env=env, stdout=log, stderr=subprocess.STDOUT)
        row = {"repeat": repeat, "arm": arm, "head": heads[arm], "exit_code": result.returncode, "seconds": time.monotonic() - started}
        results.append(row)
        (output / "results.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(row), flush=True)
raise SystemExit(any(row["exit_code"] != 0 for row in results))
