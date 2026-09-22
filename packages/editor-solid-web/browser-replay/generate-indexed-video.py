import subprocess
import sys

width = int(sys.argv[1])
height = int(sys.argv[2])
output = sys.argv[3]
track = sys.argv[4]
count = 180

if width % 8 != 0 or track not in ("display", "camera") or not output.endswith(".mp4"):
    raise RuntimeError("Indexed video arguments are invalid")

encoder = subprocess.Popen(
    [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        "30",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "0",
        "-g",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
    ],
    stdin=subprocess.PIPE,
)

if encoder.stdin is None:
    raise RuntimeError("Video encoder has no input")

stripe = width // 8
for index in range(count):
    row = b"".join(
        bytes([255 if bool((index >> bit) & 1) != (track == "camera") else 0])
        * (stripe * 3)
        for bit in range(8)
    )
    encoder.stdin.write(row * height)

encoder.stdin.close()
if encoder.wait() != 0:
    raise RuntimeError("Video encoder failed")

subprocess.run(
    [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        output,
        "-c:v",
        "libvpx",
        "-b:v",
        "0",
        "-crf",
        "4",
        "-deadline",
        "realtime",
        "-cpu-used",
        "5",
        "-g",
        "1",
        output[:-4] + ".webm",
    ],
    check=True,
)
