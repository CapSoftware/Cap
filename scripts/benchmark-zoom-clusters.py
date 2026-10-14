import argparse
import json
import math
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    parser.add_argument("--duration", type=int, default=120)
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=180)
    parser.add_argument("--short-zooms", action="store_true")
    args = parser.parse_args()
    if args.duration <= 0:
        parser.error("duration must be positive")
    if args.width <= 0 or args.height <= 0 or args.width % 2 or args.height % 2:
        parser.error("width and height must be positive even integers")
    target = args.target.resolve()
    if target.exists():
        parser.error("target must not exist")
    target.mkdir(parents=True)

    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={args.width}x{args.height}:rate=30",
            "-t",
            str(args.duration),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "35",
            "-g",
            "30",
            "-keyint_min",
            "30",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(target / "display.mp4"),
        ],
        check=True,
    )

    moves = []
    for index in range(args.duration * 60):
        time = index / 60
        phase = (time % 3.2) / 3.2
        triangle = 1 - abs(2 * phase - 1)
        moves.append(
            {
                "active_modifiers": [],
                "cursor_id": "default",
                "time_ms": time * 1000,
                "x": 0.1 + 0.8 * triangle,
                "y": 0.5 + 0.2 * math.sin(time * math.tau / 11),
            }
        )
    (target / "cursor.json").write_text(json.dumps({"moves": moves, "clicks": []}))
    metadata = {
        "pretty_name": f"Synthetic smooth cursor zoom ({args.duration}s)",
        "platform": "MacOS",
        "segments": [
            {
                "display": {"path": "display.mp4", "fps": 30},
                "cursor": "cursor.json",
            }
        ],
    }
    project = {
        "camera": {"hide": True},
        "audio": {"mute": True},
        "cursor": {"type": "circle", "useSvg": False, "raw": False},
        "screenMotionBlur": 1.0,
        "textSizeVersion": 1,
        "textAnimVersion": 1,
        "timeline": {
            "segments": [
                {
                    "recordingSegment": 0,
                    "timescale": 1.0,
                    "start": 0.0,
                    "end": args.duration,
                }
            ],
            "zoomSegments": [
                {"start": 0.0, "end": args.duration, "amount": 2.0, "mode": "auto"}
            ],
        },
    }
    if args.short_zooms:
        project["timeline"]["zoomSegments"] = [
            {
                "start": start,
                "end": min(start + 4, args.duration),
                "amount": 2,
                "mode": "auto",
            }
            for start in range(8, args.duration, 30)
        ]
    (target / "recording-meta.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (target / "project-config.json").write_text(json.dumps(project, indent=2) + "\n")

    print(
        json.dumps(
            {
                "project": str(target),
                "durationSecs": args.duration,
                "moves": len(moves),
                "videoSize": [args.width, args.height],
                "shortZooms": args.short_zooms,
            }
        )
    )


if __name__ == "__main__":
    main()
