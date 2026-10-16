from pathlib import Path
import hashlib
import json
import os
import struct
import subprocess

root = Path(os.environ["FRAGMENT_PROBE_OUT"])
records = json.loads((root / "records.json").read_text())


def prefix(data):
    offset = 0
    complete = 0
    previous = None
    boxes = []
    while offset + 8 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, offset)
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                break
            size = struct.unpack_from(">Q", data, offset + 8)[0]
            header = 16
        if size < header or offset + size > len(data):
            break
        boxes.append({"offset": offset, "size": size, "type": kind.decode("ascii")})
        offset += size
        if previous == b"moof" and kind == b"mdat":
            complete = offset
        previous = kind
    return complete, boxes


def inspect(directory):
    init = directory / "init.mp4"
    files = sorted(directory.glob("segment_*.m4s*"))
    result = {"directory": str(directory.relative_to(root)), "files": []}
    media = bytearray(init.read_bytes()) if init.exists() else bytearray()
    for path in files:
        data = path.read_bytes()
        end, boxes = prefix(data)
        result["files"].append({"name": path.name, "size": len(data), "complete_prefix": end, "boxes": boxes})
        if end:
            media.extend(data[:end])
    result["container_bytes"] = len(media)
    if not any(row["complete_prefix"] for row in result["files"]):
        result.update(packets=0, frames=0, payload_bytes=0, keys=[], packet_hashes=[], frame_hashes=[], pts=[])
        return result
    combined = directory / "probe-combined.mp4"
    combined.write_bytes(media)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts_time,dts_time,duration_time,size,flags,data_hash", "-of", "json", str(combined)], capture_output=True, text=True, check=True)
    packets = json.loads(probe.stdout)["packets"]
    decoded = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(combined), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "framemd5", "-"], capture_output=True, text=True, check=True)
    hashes = [line.split(",")[-1].strip() for line in decoded.stdout.splitlines() if line and not line.startswith("#")]
    result.update(packets=len(packets), frames=len(hashes), payload_bytes=sum(int(p["size"]) for p in packets), keys=[float(p["pts_time"]) for p in packets if "K" in p["flags"]], pts=[float(p["pts_time"]) for p in packets], packet_hashes=[p["data_hash"] for p in packets], frame_hashes=hashes, decode_stderr=decoded.stderr, packet_stderr=probe.stderr)
    (directory / "packet-table.json").write_text(json.dumps(packets, indent=2))
    (directory / "framemd5.txt").write_text(decoded.stdout)
    combined.unlink()
    return result


summary = []
for record in records:
    base = root / f"step-{record['step']}"
    final = {mode["mode"]: inspect(base / mode["mode"]) for mode in record["modes"]}
    reference = final["control"]
    rows = []
    for mode in record["modes"]:
        name = mode["mode"]
        full = final[name]
        full["identical_payload"] = full["packet_hashes"] == reference["packet_hashes"]
        full["identical_decoded_frames"] = full["frame_hashes"] == reference["frame_hashes"]
        full["identical_pts"] = full["pts"] == reference["pts"]
        full["container_delta_percent"] = 100 * (full["container_bytes"] / reference["container_bytes"] - 1)
        for snap in mode["snapshots"]:
            row = inspect(base / snap["directory"])
            row["input_pts"] = snap["input_pts"]
            row["input_packets"] = snap["input_packets"]
            row["identical_decoded_prefix"] = row["frame_hashes"] == reference["frame_hashes"][:row["frames"]]
            row["identical_pts_prefix"] = row["pts"] == reference["pts"][:row["packets"]]
            row["lag_seconds"] = snap["input_pts"] - row["pts"][-1] if row["pts"] else None
            row["mode"] = name
            rows.append(row)
    for result in list(final.values()) + rows:
        result.pop("packet_hashes")
        result.pop("frame_hashes")
        result["pts"] = {"first": result["pts"][0], "last": result["pts"][-1]} if result["pts"] else None
    summary.append({"fps": record["fps"], "codec": record["codec"], "final": final, "snapshots": rows})
    (root / "analysis.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({"fps": record["fps"], "final": {k: {f: v[f] for f in ["packets", "frames", "payload_bytes", "container_bytes", "container_delta_percent", "identical_payload", "identical_decoded_frames", "identical_pts"]} for k, v in final.items()}, "snapshots": [{k: r[k] for k in ["mode", "input_pts", "packets", "lag_seconds", "identical_decoded_prefix"]} for r in rows]}), flush=True)

(root / "provenance.json").write_text(json.dumps({"head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "ffmpeg": subprocess.check_output(["ffmpeg", "-version"], text=True), "source_sha256": hashlib.sha256(Path("crates/enc-ffmpeg/examples/sol-fragment-proof.rs").read_bytes()).hexdigest()}, indent=2))
