import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import re
import subprocess
import time

import numpy as np


def execute(args, timeout=600):
	started = time.monotonic()
	result = subprocess.run(args, capture_output=True, timeout=timeout)
	if result.returncode:
		raise RuntimeError(f"{args[0]} exited {result.returncode}: {result.stderr.decode(errors='replace')[-500:]}")
	return result, time.monotonic() - started


def measure(path):
	probe, _ = execute(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)])
	metadata = json.loads(probe.stdout)
	stream = next(s for s in metadata["streams"] if s["codec_type"] == "audio")
	result, elapsed = execute(["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-vn", "-af", "loudnorm=I=-16:TP=-2:LRA=11:dual_mono=true:print_format=json", "-f", "null", "-"])
	log = result.stderr.decode()
	values = json.loads(log[log.rfind("{"):log.rfind("}") + 1])
	return {"lufs": float(values["input_i"]), "truePeak": float(values["input_tp"]), "lra": float(values["input_lra"]), "threshold": float(values["input_thresh"]), "duration": float(stream.get("duration", metadata["format"]["duration"])), "channels": stream["channels"], "sampleRate": int(stream["sample_rate"]), "codec": stream["codec_name"], "bitrate": int(stream.get("bit_rate", 0)), "measurementSeconds": elapsed}


def speech_metrics(path, transcript):
	result, _ = execute(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-c:a", "pcm_f32le", "-"])
	samples = np.frombuffer(result.stdout, dtype=np.float32)
	n = len(samples) // 320
	frames = samples[:n * 320].reshape(n, 320).astype(np.float64)
	power = np.mean(frames * frames, axis=1)
	centers = (np.arange(n) + .5) * .02
	speech = np.zeros(n, dtype=bool)
	pauses = np.ones(n, dtype=bool)
	cues = []
	for match in re.finditer(r"(\d+):(\d+):(\d+\.\d+) --> (\d+):(\d+):(\d+\.\d+)", transcript):
		v = list(map(float, match.groups()))
		start, end = v[0] * 3600 + v[1] * 60 + v[2], v[3] * 3600 + v[4] * 60 + v[5]
		cues.append((start, end))
		speech |= (centers >= start) & (centers <= end)
		pauses &= ~((centers >= start - .25) & (centers <= end + .25))
	def db(values):
		return float(10 * np.log10(max(float(np.mean(values)), 1e-24))) if len(values) else None
	return {"decodedDuration": len(samples) / 16000, "cueCount": len(cues), "lastCueEnd": max((e for _, e in cues), default=0), "captionCoverage": float(speech.mean()) if n else 0, "captionRms": db(power[speech]), "pauseRms": db(power[pauses]), "pauseSeconds": float(pauses.sum() * .02), "silentFrameFraction": float(np.mean(power < 1e-9)) if n else 1}


def baseline(row, root):
	vid = row["id"]
	out = root / "baseline" / f"{vid}.json"
	if out.exists():
		return json.loads(out.read_text())
	media = root / "sources" / f"{vid}.m4a"
	vtt = root / "sources" / f"{vid}.vtt"
	if not vtt.exists():
		execute(["cap", "caps", "transcript", vid, "--format", "vtt", "--output", str(vtt), "--json"])
	if not media.exists():
		part = media.with_suffix(".partial.m4a")
		execute(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", f"https://cap.so/api/playlist?videoId={vid}&videoType=mp4", "-map", "0:a:0", "-vn", "-c:a", "copy", str(part)])
		part.rename(media)
	metrics = measure(media)
	metrics.update(speech_metrics(media, vtt.read_text()))
	metrics.update({"id": vid, "split": row["split"], "stratum": row["stratum"], "createdAt": row["createdAt"], "databaseDuration": row["duration"], "sourceSha256": hashlib.sha256(media.read_bytes()).hexdigest(), "transcriptSha256": hashlib.sha256(vtt.read_bytes()).hexdigest()})
	out.write_text(json.dumps(metrics, indent=2, allow_nan=True))
	print(json.dumps({"baseline": vid, "lufs": metrics["lufs"], "peak": metrics["truePeak"], "duration": metrics["duration"]}), flush=True)
	return metrics


def candidate(row, root, policy):
	out = root / policy / f"{row['id']}.json"
	if out.exists():
		return json.loads(out.read_text())
	media = root / "sources" / f"{row['id']}.m4a"
	gain = min(-16 - row["lufs"], 12, -2 - row["truePeak"])
	if policy == "gain6":
		gain = min(gain, 6)
	if policy.startswith("gain") and (not np.isfinite(gain) or gain < 1 or row["lufs"] < -50 or row["duration"] < 3 or row["channels"] > 2):
		result = {"id": row["id"], "split": row["split"], "policy": policy, "status": "unchanged", "gain": 0, "input": row, "output": row, "processingSeconds": 0}
	else:
		filters = "loudnorm=I=-16:TP=-2:LRA=11:dual_mono=true" if policy == "dynamic" else f"volume={gain:.6f}dB"
		if policy in ["equalized", "clean"]:
			pre_gain = min(18, max(0, -20 - row["lufs"]))
			filters = f"volume={pre_gain:.6f}dB,highpass=f=70,equalizer=f=250:t=q:w=0.8:g=-1.5,equalizer=f=2500:t=q:w=0.7:g=1.5"
			if policy == "clean":
				filters += ",afftdn=nr=6:nf=-45:tn=1:gs=5"
			filters += ",acompressor=threshold=0.125:ratio=2:attack=15:release=200:makeup=1,loudnorm=I=-16:TP=-2:LRA=11:dual_mono=true"
		path = root / policy / f"{row['id']}.m4a"
		_, elapsed = execute(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(media), "-map", "0:a:0", "-af", filters, "-ar", str(row["sampleRate"]), "-c:a", "aac", "-b:a", "192k" if row["channels"] == 1 else "256k", str(path)])
		output = measure(path)
		output.update(speech_metrics(path, (root / "sources" / f"{row['id']}.vtt").read_text()))
		result = {"id": row["id"], "split": row["split"], "policy": policy, "status": "rendered", "gain": gain if policy != "dynamic" else None, "input": row, "output": output, "processingSeconds": elapsed, "realtimeFactor": elapsed / row["duration"], "durationDeltaMs": (output["duration"] - row["duration"]) * 1000, "lufsDelta": output["lufs"] - row["lufs"], "lraDelta": output["lra"] - row["lra"], "sourceUnchanged": hashlib.sha256(media.read_bytes()).hexdigest() == row["sourceSha256"]}
		result["filters"] = filters
		if row["pauseRms"] is not None and output["pauseRms"] is not None:
			result["loudnessMatchedPauseChangeDb"] = output["pauseRms"] - row["pauseRms"] - result["lufsDelta"]
	out.write_text(json.dumps(result, indent=2, allow_nan=True))
	print(json.dumps({"policy": policy, "id": row["id"], "status": result["status"], "outputLufs": result["output"]["lufs"]}), flush=True)
	return result


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("root", type=pathlib.Path)
	parser.add_argument("--phase", choices=["baseline", "tuning", "holdout"], default="baseline")
	parser.add_argument("--policies", nargs="+", default=["gain6", "gain12", "dynamic"])
	args = parser.parse_args()
	for name in ["sources", "baseline", *args.policies]:
		(args.root / name).mkdir(parents=True, exist_ok=True)
	rows = json.loads((args.root / "cohort.json").read_text())
	jobs = [(row, None) for row in rows] if args.phase == "baseline" else [(json.loads((args.root / "baseline" / f"{row['id']}.json").read_text()), policy) for row in rows if row["split"] == args.phase for policy in args.policies]
	results = []
	with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
		futures = {pool.submit(baseline, row, args.root) if policy is None else pool.submit(candidate, row, args.root, policy): row["id"] for row, policy in jobs}
		for future in concurrent.futures.as_completed(futures):
			try:
				results.append(future.result())
			except Exception as error:
				print(json.dumps({"id": futures[future], "error": str(error)}), flush=True)
	(args.root / f"{args.phase}-results.json").write_text(json.dumps(results, indent=2, allow_nan=True))
	if len(results) != len(jobs):
		raise SystemExit(f"Only {len(results)}/{len(jobs)} jobs succeeded")


if __name__ == "__main__":
	main()
