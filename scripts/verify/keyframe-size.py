from pathlib import Path
import hashlib
import json
import os
import subprocess

root = Path.cwd()
output = Path(os.environ["RUNNER_TEMP"]) / "keyframe-size"
output.mkdir(parents=True, exist_ok=True)
source = (root / "scripts/verify/keyframe-size.rs").read_bytes()
heads = {"control":"d79513f266a92e506b275677e9d40eac31ba4605", "candidate":"bed1bb056cae8c8381128fbed9083db55375344f"}
rows = []
for arm, head in heads.items():
    subprocess.run(["git", "fetch", "origin", head], check=True)
    subprocess.run(["git", "checkout", "--detach", head], check=True)
    example = root / "crates/enc-ffmpeg/examples/sol-keyframe-proof.rs"
    example.parent.mkdir(exist_ok=True)
    example.write_bytes(source)
    with (output / f"build-{arm}.log").open("w") as log:
        subprocess.run(["cargo", "build", "--profile", "ci-verify", "--locked", "-p", "cap-enc-ffmpeg", "--example", "sol-keyframe-proof"], stdout=log, stderr=subprocess.STDOUT, check=True)
    for step in [1, 2, 10, 30]:
        media = output / f"{arm}-{step}.h264"
        run = subprocess.run([str(root / "target/ci-verify/examples/sol-keyframe-proof"), "libx264", str(step), "60", str(media)], capture_output=True, text=True, check=True)
        (output / f"{arm}-{step}.log").write_text(run.stdout + run.stderr)
        record = json.loads(run.stdout)
        header = bytes(record.pop("extradata"))
        record.update(arm=arm, head=head, header_bytes=len(header), file_bytes=media.stat().st_size + len(header), encoded_sha256=hashlib.sha256(media.read_bytes()).hexdigest(), extradata_sha256=hashlib.sha256(header).hexdigest())
        rows.append(record)
        (output / "records.json").write_text(json.dumps(rows,indent=2))
        media.unlink()
        print(json.dumps(record),flush=True)
