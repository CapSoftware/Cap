import json
import os
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parent
env = dict(os.environ, CARGO_BUILD_JOBS="2")
for mode, directory in [("baseline", "baseline"), ("candidate", "candidate")]:
    process = subprocess.run(
        ["cargo", "+stable", "test", "--release", "--locked", "-j2", "--manifest-path", str(root / directory / "Cargo.toml"), "--lib", "--no-run", "--message-format=json"],
        stdout=subprocess.PIPE, text=True, env=env, check=True, timeout=600,
    )
    items = [json.loads(line) for line in process.stdout.splitlines() if line.startswith("{")]
    binaries = [item["executable"] for item in items if item.get("reason") == "compiler-artifact" and item.get("executable")]
    assert len(binaries) == 1
    binary = root / f"release-{mode}-tests"
    shutil.copy2(binaries[0], binary)
    if mode == "candidate":
        listing = subprocess.check_output([str(binary), "--list"], text=True)
        assert "next_url_is_prefetched_while_puts_remain_ordered_and_byte_exact" in listing
    subprocess.run([str(binary), "--test-threads=1"], check=True, timeout=60)
