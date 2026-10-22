#!/usr/bin/env python3
import argparse
import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bench"))

from harness.corpus import load_manifest, prepare_source  # noqa: E402

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
LDECOD = os.environ.get("LDECOD", "ldecod")


def md5_frames(path: Path, frame_bytes: int) -> list[str]:
    out = []
    with open(path, "rb") as f:
        while True:
            b = f.read(frame_bytes)
            if len(b) < frame_bytes:
                break
            out.append(hashlib.md5(b).hexdigest())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="encode a corpus clip and check ffmpeg and JM decodes against the recon")
    ap.add_argument("clip")
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--binary", default=str(ROOT / "build" / "capcodec"))
    ap.add_argument("--no-sideinfo", action="store_true")
    a, extra = ap.parse_known_args()
    clips = {c.name: c for c in load_manifest()}
    src = prepare_source(clips[a.clip], a.height, a.seconds)
    fb = src.width * src.height * 3 // 2
    with tempfile.TemporaryDirectory() as td:
        t = Path(td)
        cmd = [a.binary, "encode", "--input", str(src.path), "--output", str(t / "o.264"), "--recon", str(t / "rec.yuv"),
               "--width", str(src.width), "--height", str(src.height), "--fps", src.fps_arg] + extra
        if src.sideinfo and not a.no_sideinfo:
            cmd += ["--sideinfo", str(src.sideinfo)]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0:
            print(r.stderr.decode(errors="replace"))
            return 1
        print(r.stderr.decode().strip())
        rec = md5_frames(t / "rec.yuv", fb)
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(t / "o.264"), "-f", "rawvideo",
                        "-pix_fmt", "yuv420p", str(t / "ff.yuv")], check=True)
        ff = md5_frames(t / "ff.yuv", fb)
        jr = subprocess.run([LDECOD, "-p", f"InputFile={t / 'o.264'}", "-p", f"OutputFile={t / 'jm.yuv'}",
                             "-p", "WriteUV=1"], capture_output=True, cwd=td)
        text = (jr.stdout + jr.stderr).decode(errors="replace")
        bad = [ln for ln in text.splitlines() if "error" in ln.lower() or "warning" in ln.lower()]
        jm = md5_frames(t / "jm.yuv", fb) if (t / "jm.yuv").exists() else []
        ok_ff = ff == rec and len(rec) > 0
        ok_jm = jm == rec and not bad
        first_ff = next((i for i, (x, y) in enumerate(zip(ff, rec)) if x != y), None)
        first_jm = next((i for i, (x, y) in enumerate(zip(jm, rec)) if x != y), None)
        stream_md5 = hashlib.md5((t / "o.264").read_bytes()).hexdigest()
        print(f"frames recon {len(rec)} ffmpeg {len(ff)} jm {len(jm)}; ffmpeg match {ok_ff} (first diff {first_ff}); "
              f"jm match {ok_jm} (first diff {first_jm}) {bad[:3]}; stream md5 {stream_md5}")
        return 0 if ok_ff and ok_jm else 1


if __name__ == "__main__":
    sys.exit(main())
