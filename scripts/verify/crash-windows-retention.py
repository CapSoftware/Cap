import json
import os
from pathlib import Path
import shutil
import subprocess
import time

root = Path.cwd()
output = Path(os.environ["RUNNER_TEMP"]) / "crash-windows-retention"
output.mkdir(parents=True, exist_ok=True)
heads = {
    "control": os.environ["CRASH_CONTROL_HEAD"],
    "2642": os.environ["CRASH_CANDIDATE_HEAD"],
}
binaries = {}
for arm, head in heads.items():
    subprocess.run(["git", "fetch", "origin", head], check=True)
    subprocess.run(["git", "checkout", "--detach", head], check=True)
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if actual != head:
        raise SystemExit(f"{arm}: expected {head}, got {actual}")
    build = output / "build" / arm
    build.mkdir(parents=True)
    (build / "head.txt").write_text(head + "\n")
    shutil.copyfile(root / "crates/verify/expectations.toml", build / "expectations.toml")
    shutil.copyfile(root / "crates/verify/tests/crash.rs", build / "crash.rs")
    for name, command in [
        ("format", ["cargo", "fmt", "--all", "--", "--check"]),
        ("clippy", ["cargo", "clippy", "--profile", "ci-verify", "--locked", "-p", "cap-verify", "--test", "crash", "--", "-D", "warnings"]),
    ]:
        with (build / f"{name}.log").open("w") as log:
            subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
    with (build / "build.jsonl").open("w") as stdout, (build / "build.log").open("w") as stderr:
        subprocess.run([
            "cargo", "test", "--profile", "ci-verify", "--locked", "-p", "cap-verify",
            "--test", "crash", "--no-run", "--message-format=json",
        ], check=True, stdout=stdout, stderr=stderr)
    rows = [json.loads(line) for line in (build / "build.jsonl").read_text().splitlines()]
    executables = [row["executable"] for row in rows if row.get("reason") == "compiler-artifact" and row.get("executable") and row.get("target", {}).get("name") == "crash"]
    if len(executables) != 1:
        raise SystemExit(f"{arm}: unexpected crash executables: {executables}")
    original = Path(executables[0])
    binary = original.with_name(f"crash-retention-{arm}.exe")
    shutil.copy2(original, binary)
    with (build / "coverage-guard.log").open("w") as log:
        subprocess.run([
            str(binary), "--exact",
            "finalize_coverage_rejects_completion_missing_barrier_and_exited_child",
            "--nocapture",
        ], check=True, stdout=log, stderr=subprocess.STDOUT)
    if "1 passed" not in (build / "coverage-guard.log").read_text():
        raise SystemExit(f"{arm}: coverage guard did not execute")
    binaries[arm] = binary
    print(f"built {arm} {head}", flush=True)
(output / "heads.json").write_text(json.dumps(heads, indent=2))
results = []
for repeat in range(1, 6):
    for arm, head in heads.items():
        case_dir = output / f"repeat-{repeat}" / arm
        case_dir.mkdir(parents=True)
        shutil.copyfile(output / "build" / arm / "expectations.toml", root / "crates/verify/expectations.toml")
        env = os.environ.copy()
        env.update({
            "CAP_VERIFY_KEEP": "1",
            "CAP_VERIFY_SCRATCH": str(case_dir / "raw"),
            "CAP_VERIFY_REPORT_DIR": str(case_dir / "report"),
            "CAP_VERIFY_TIER": "full",
            "CAP_VERIFY_CASE": "crash/recorder-kill/inproc/finalize+0ms,crash/recorder-kill/inproc/finalize+40ms",
            "CAP_VERIFY_LOG": "cap_recording=info,cap_enc_ffmpeg=debug",
            "CAP_VERIFY_HOST": "blacksmith",
        })
        started = time.monotonic()
        with (case_dir / "execution.log").open("w") as log:
            result = subprocess.run([
                str(binaries[arm]), "--exact", "crash_safety", "--nocapture", "--test-threads=1",
            ], env=env, stdout=log, stderr=subprocess.STDOUT)
        row = {"repeat": repeat, "arm": arm, "head": head, "exit_code": result.returncode, "seconds": time.monotonic() - started}
        results.append(row)
        (output / "results.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(row), flush=True)
raise SystemExit(any(row["exit_code"] != 0 for row in results))
