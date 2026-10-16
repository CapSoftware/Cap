from pathlib import Path
import json
import os
import shutil
import subprocess

root = Path.cwd()
output = Path(os.environ["RUNNER_TEMP"]) / "keyframe-proof"
output.mkdir(parents=True, exist_ok=True)
script = Path(__file__).read_bytes()
heads = {
    "control": "d79513f266a92e506b275677e9d40eac31ba4605",
    "candidate": "bed1bb056cae8c8381128fbed9083db55375344f",
}
results = []
for arm, head in heads.items():
    subprocess.run(["git", "fetch", "origin", head], check=True)
    subprocess.run(["git", "checkout", "--detach", head], check=True)
    folder = output / arm
    folder.mkdir()
    (folder / "head.txt").write_text(head + "\n")
    (folder / "driver.py").write_bytes(script)
    shutil.copyfile(root / "crates/verify/expectations.toml", folder / "expectations.toml")
    environment = os.environ.copy()
    environment.update({
        "CAP_VERIFY_KEEP": "1",
        "CAP_VERIFY_SCRATCH": str(folder / "raw"),
        "CAP_VERIFY_REPORT_DIR": str(folder / "report"),
        "CAP_VERIFY_TIER": "full",
        "CAP_VERIFY_HOST": "github-hosted",
        "CAP_VERIFY_LOG": "cap_recording=info,cap_enc_ffmpeg=debug",
    })
    commands = [
        ("library", ["cargo", "test", "--locked", "--profile", "ci-verify", "-p", "cap-enc-ffmpeg", "--lib", "--", "--nocapture", "--test-threads=1"]),
        ("muxer-build", ["cargo", "build", "--locked", "--profile", "ci-verify", "-p", "cap-muxer"]),
        ("crash", ["cargo", "test", "--locked", "--profile", "ci-verify", "-p", "cap-verify", "--test", "crash", "--", "--exact", "crash_safety", "--nocapture", "--test-threads=1"]),
    ]
    for name, command in commands:
        with (folder / f"{name}.log").open("w") as log:
            result = subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT)
        row = {"arm": arm, "head": head, "stage": name, "exit_code": result.returncode}
        results.append(row)
        (output / "results.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(row), flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
