import json
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
records = json.loads((root / "records.json").read_text())


def inspect(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts_time,dts_time,duration_time,size,flags,data_hash", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    packets = json.loads(result.stdout)["packets"]
    decoded = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "framemd5", "-"], capture_output=True, text=True, check=True)
    frames = [line.split(",")[-1].strip() for line in decoded.stdout.splitlines() if line and not line.startswith("#")]
    return {"packets": packets, "frames": frames, "size": path.stat().st_size, "payload": sum(int(packet["size"]) for packet in packets), "decode_stderr": decoded.stderr}


results = []
for step in [1, 2, 10, 30]:
    outputs = {}
    for mode in ["control-calibration", "control", "timed"]:
        record = next(record for record in records if record["step"] == step and record["mode"] == mode)
        directory = root / f"{step}/{mode}"
        full = inspect(directory / "final.mp4")
        snapshots = []
        for snapshot in record["snapshots"]:
            path = directory / f"{snapshot['directory']}.mp4"
            data = inspect(path) if path.is_file() else None
            snapshots.append({**snapshot, "result": data})
        outputs[mode] = {"full": full, "snapshots": snapshots, "segments": record["segments"]}
    reference = outputs["control"]["full"]
    for mode, output in outputs.items():
        actual = output["full"]
        output["same_payload"] = [packet["data_hash"] for packet in actual["packets"]] == [packet["data_hash"] for packet in reference["packets"]]
        output["same_frames"] = actual["frames"] == reference["frames"]
        output["same_timestamps"] = [(packet["pts_time"], packet["dts_time"], packet.get("duration_time")) for packet in actual["packets"]] == [(packet["pts_time"], packet["dts_time"], packet.get("duration_time")) for packet in reference["packets"]]
        output["container_delta_percent"] = 100 * (actual["size"] / reference["size"] - 1)
        for snapshot in output["snapshots"]:
            data = snapshot["result"]
            if data:
                snapshot["exact_prefix"] = data["frames"] == reference["frames"][:len(data["frames"])]
                snapshot["input_to_last_durable_pts"] = snapshot["input_pts"] - float(data["packets"][-1]["pts_time"])
    results.append({"step": step, "outputs": outputs})
(root / "analysis.json").write_text(json.dumps(results, indent=2))
for result in results:
    for output in result["outputs"].values():
        assert output["same_payload"] and output["same_frames"] and output["same_timestamps"]
        for snapshot in output["snapshots"]:
            assert snapshot["result"] is None or snapshot["exact_prefix"]
print(json.dumps([{ "step": result["step"], "timed": {key: value for key, value in result["outputs"]["timed"].items() if key != "full"} } for result in results], default=str))
