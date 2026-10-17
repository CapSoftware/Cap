import argparse
import json
import math
import shutil
import subprocess
from pathlib import Path


def add_cursor(fixture, assets_directory):
    fixture = fixture.resolve()
    marker = json.loads((fixture / "SYNTHETIC-FIXTURE.json").read_text())
    if marker.get("synthetic") is not True or marker.get("audio_only"):
        raise SystemExit("Only disposable synthetic full fixtures may be modified")
    meta_path = fixture / "recording-meta.json"
    meta = json.loads(meta_path.read_text())
    if len(meta.get("segments", [])) != 1:
        raise SystemExit("Expected one multi-segment recording entry")
    assets = json.loads((assets_directory / "cursors.json").read_text())
    for cursor_id in ("0", "2"):
        relative = assets[cursor_id]["imagePath"]
        source = assets_directory / f"cursor_{cursor_id}.png"
        destination = fixture / relative
        if destination.exists() and destination.read_bytes() != source.read_bytes():
            raise SystemExit(f"Refusing to replace different cursor asset: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    duration = float(marker["export_seconds"])
    sample_count = max(2, math.ceil(duration * 60))
    moves = []
    for index in range(sample_count + 1):
        phase = index / sample_count
        moves.append({
            "active_modifiers": [], "cursor_id": "0" if phase < 0.5 else "2",
            "time_ms": phase * duration * 1000,
            "x": 0.2 + 0.6 * phase,
            "y": 0.5 + 0.2 * math.sin(phase * math.tau),
        })
    click_time_ms = duration * 0.7 * 1000
    clicks = [
        {"active_modifiers": [], "cursor_num": 1, "cursor_id": "2",
         "time_ms": click_time_ms, "down": True},
        {"active_modifiers": [], "cursor_num": 1, "cursor_id": "2",
         "time_ms": click_time_ms + 80, "down": False},
    ]
    cursor_path = fixture / "content/cursor-campaign.json"
    cursor_path.write_text(json.dumps({"moves": moves, "clicks": clicks}, indent=2) + "\n")
    meta["cursors"] = {cursor_id: assets[cursor_id] for cursor_id in ("0", "2")}
    meta["segments"][0]["cursor"] = "content/cursor-campaign.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    marker["cursor_trajectory"] = "Synthetic normalized 60Hz movement, arrow-to-hand, one click"
    marker["cursor_asset_source"] = str(assets_directory.resolve())
    (fixture / "SYNTHETIC-FIXTURE.json").write_text(json.dumps(marker, indent=2) + "\n")
    print(json.dumps({"fixture": str(fixture), "moves": len(moves), "clicks": len(clicks),
                      "cursor_ids": ["0", "2"], "source": str(assets_directory.resolve())}))



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    parser.add_argument("--source-seconds", type=int, default=600)
    parser.add_argument("--export-seconds", type=float, default=4)
    parser.add_argument("--audio-only", action="store_true")
    parser.add_argument("--with-cursor", action="store_true")
    parser.add_argument("--cursor-assets", type=Path, default=Path(__file__).resolve().parents[1] /
                        "apps/cli/skill/cap-demo/assets")
    args = parser.parse_args()
    if args.audio_only and args.with_cursor:
        parser.error("--with-cursor requires video generation")
    target = args.destination.resolve()
    if target.exists():
        raise SystemExit("Refusing to replace an existing fixture directory")
    if args.source_seconds <= 0 or not 0 < args.export_seconds <= args.source_seconds:
        raise SystemExit("Invalid durations")
    content = target / "content"
    content.mkdir(parents=True)
    for name, frequency in [("mic", 440), ("system", 880)]:
        subprocess.run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration={args.source_seconds}",
            "-ac", "2", "-c:a", "aac", "-b:a", "96k", str(content / f"{name}.m4a"),
        ], check=True)
    if not args.audio_only:
        subprocess.run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=0x234567:size=640x360:rate=15:duration={args.source_seconds}",
            "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2",
            "-pix_fmt", "yuv420p", str(content / "display.mp4"),
        ], check=True)
    meta = {
        "pretty_name": "SYNTHETIC disposable video-only export benchmark",
        "sharing": None,
        "segments": [{
            "display": {"path": "content/display.mp4", "fps": 15},
            "mic": {"path": "content/mic.m4a"},
            "system_audio": {"path": "content/system.m4a"},
        }],
    }
    config = {
        "background": {"source": {"type": "color", "value": [30, 30, 46]}, "padding": 0},
        "camera": {"hide": True},
        "audio": {"mute": True},
        "timeline": {"segments": [{"recordingSegment": 0, "timescale": 1.0, "start": 0.0,
                                     "end": args.export_seconds}], "zoomSegments": []},
    }
    (target / "recording-meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    (target / "project-config.json").write_text(json.dumps(config, indent=2) + "\n")
    (target / "SYNTHETIC-FIXTURE.json").write_text(json.dumps({
        "synthetic": True, "source_seconds": args.source_seconds,
        "export_seconds": args.export_seconds, "audio_only": args.audio_only,
        "purpose": "Real Cap builder/export or ProgressiveAudio workload, synthetic inputs",
    }, indent=2) + "\n")
    if args.with_cursor:
        add_cursor(target, args.cursor_assets)
    print(target)


if __name__ == "__main__":
    main()
