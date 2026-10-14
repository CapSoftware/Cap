import argparse
import json
import subprocess
from pathlib import Path

ALPHA_READ_BYTES = 64 * 1024


def read_alpha_extrema(stream):
    minimum = None
    maximum = None
    while True:
        chunk = stream.read(ALPHA_READ_BYTES)
        if not chunk:
            return minimum, maximum
        chunk_minimum = min(chunk)
        chunk_maximum = max(chunk)
        minimum = chunk_minimum if minimum is None else min(minimum, chunk_minimum)
        maximum = chunk_maximum if maximum is None else max(maximum, chunk_maximum)


def alpha_extrema(path):
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(path), "-map", "0:v:0", "-vf", "alphaextract",
        "-pix_fmt", "gray", "-f", "rawvideo", "-",
    ]
    with subprocess.Popen(command, stdout=subprocess.PIPE) as process:
        try:
            if process.stdout is None:
                raise RuntimeError("FFmpeg alpha output pipe was not created")
            extrema = read_alpha_extrema(process.stdout)
        except BaseException:
            process.kill()
            process.wait()
            raise
        returncode = process.wait()
        if returncode:
            raise subprocess.CalledProcessError(returncode, command)
        return extrema


def probe(path):
    raw = subprocess.check_output([
        "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format",
        "-of", "json", str(path),
    ])
    data = json.loads(raw)
    selected = []
    for stream in data["streams"]:
        selected.append({key: stream.get(key) for key in [
            "codec_name", "codec_type", "width", "height", "pix_fmt", "time_base",
            "duration", "nb_read_frames", "avg_frame_rate",
        ]})
    return selected


def frames(path, alpha=False):
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path),
               "-map", "0:v:0"]
    if alpha:
        command += ["-vf", "alphaextract"]
    else:
        command += ["-pix_fmt", "rgba"]
    command += ["-f", "framemd5", "-"]
    raw = subprocess.check_output(command).decode()
    return [line.strip() for line in raw.splitlines() if line and not line.startswith("#")]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--alpha", action="store_true")
    parser.add_argument("--require-visible-alpha", action="store_true")
    args = parser.parse_args()
    if args.require_visible_alpha and not args.alpha:
        parser.error("--require-visible-alpha requires --alpha")
    a, b = probe(args.baseline), probe(args.candidate)
    if a != b:
        raise SystemExit(f"Stream metadata differs: {a!r} vs {b!r}")
    if any(stream["codec_type"] == "audio" for stream in a):
        raise SystemExit("Unexpected audio stream in video-only export")
    fa, fb = frames(args.baseline), frames(args.candidate)
    if not fa or fa != fb:
        raise SystemExit("Decoded frame checksums, PTS, durations, or order differ")
    alpha_match = None
    visible_alpha = None
    if args.alpha:
        aa, ab = frames(args.baseline, True), frames(args.candidate, True)
        alpha_match = bool(aa) and aa == ab
        if not alpha_match:
            raise SystemExit("Decoded alpha differs")
        if args.require_visible_alpha:
            minimum, maximum = alpha_extrema(args.baseline)
            hashes = {line.rsplit(",", 1)[-1].strip() for line in aa}
            visible_alpha = minimum == 0 and maximum is not None and maximum > 0 and len(hashes) > 1
            if not visible_alpha:
                raise SystemExit("Cursor alpha is empty, fully opaque, or static")
    print(json.dumps({"decoded_frame_parity": True, "frames": len(fa),
                      "streams": a, "alpha_parity": alpha_match,
                      "visible_moving_alpha": visible_alpha}))


if __name__ == "__main__":
    main()
