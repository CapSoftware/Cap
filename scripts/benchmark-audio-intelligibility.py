import argparse
import concurrent.futures
import importlib.util
import json
import pathlib

import numpy as np
from pystoi import stoi
from scipy.io import wavfile
from scipy.signal import correlate, correlation_lags, lfilter

spec = importlib.util.spec_from_file_location("benchmark", pathlib.Path(__file__).with_name("benchmark-instant-audio.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def decode(path):
	result, _ = benchmark.execute(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"])
	return np.frombuffer(result.stdout, dtype=np.float32).astype(np.float64)


def sdr(reference, output):
	projection = np.dot(reference, output) / max(np.dot(reference, reference), 1e-20) * reference
	return float(10 * np.log10(max(np.sum(projection ** 2), 1e-20) / max(np.sum((output - projection) ** 2), 1e-20)))


def score_signals(reference, noisy, output):
	n = min(len(reference), len(noisy), len(output))
	a, baseline, b = reference[:n], noisy[:n], output[:n]
	correlation = correlate(b, a, method="fft")
	lags = correlation_lags(len(b), len(a))
	region = np.abs(lags) <= 1600
	lag = int(lags[region][np.argmax(correlation[region])])
	unaligned_input = float(stoi(a, baseline, 16000))
	unaligned_output = float(stoi(a, b, 16000))
	if lag > 0:
		a, baseline, b = a[:-lag], baseline[:-lag], b[lag:]
	elif lag < 0:
		a, baseline, b = a[-lag:], baseline[-lag:], b[:lag]
	input_stoi = float(stoi(a, baseline, 16000))
	output_stoi = float(stoi(a, b, 16000))
	return {"metricVersion": "aligned-v1", "inputStoi": input_stoi, "outputStoi": output_stoi, "stoiDelta": output_stoi - input_stoi, "inputSiSdr": sdr(a, baseline), "outputSiSdr": sdr(a, b), "lagMs": lag / 16, "evaluatedSamples": len(a), "unalignedInputStoi": unaligned_input, "unalignedOutputStoi": unaligned_output, "unalignedStoiDelta": unaligned_output - unaligned_input}


def evaluate(case, root):
	name, reference, noisy = case
	case_path = root / f"{name}.wav"
	wavfile.write(case_path, 16000, noisy.astype(np.float32))
	base = benchmark.measure(case_path)
	results = []
	policies = ["levels", "equalized-v2", "clean-v2"] if root.name.endswith("-v2") else ["levels", "equalized", "clean", "clean3"]
	if "strength" in root.name:
		policies = ["clean6-v2", "clean12-v2"]
	for policy in policies:
		gain = min(18, max(0, -20 - base["lufs"]))
		filters = f"volume={gain:.6f}dB"
		if policy.endswith("-v2"):
			filters += ",highpass=f=60,equalizer=f=250:t=q:w=0.8:g=-0.75,equalizer=f=2500:t=q:w=0.7:g=0.75"
			if policy.startswith("clean"):
				strength = 6 if policy == "clean6-v2" else 12 if policy == "clean12-v2" else 3
				filters += f",apad=pad_len=400,afftdn=nr={strength}:nf=-45:tn=1:gs=5,atrim=start_sample=400:end_sample={len(reference)+400},asetpts=N/SR/TB"
		elif policy != "levels":
			filters += ",highpass=f=70,equalizer=f=250:t=q:w=0.8:g=-1.5,equalizer=f=2500:t=q:w=0.7:g=1.5"
		if policy in ["clean", "clean3"]:
			filters += f",afftdn=nr={6 if policy == 'clean' else 3}:nf=-45:tn=1:gs=5"
		if policy != "levels" and not policy.endswith("-v2"):
			filters += ",acompressor=threshold=0.125:ratio=2:attack=15:release=200:makeup=1"
		filters += f",loudnorm=I=-16:TP=-2:LRA=11:dual_mono=true,aresample=16000,atrim=end_sample={len(reference)},asetpts=N/SR/TB"
		output = root / f"{name}-{policy}.m4a"
		_, elapsed = benchmark.execute(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(case_path), "-af", filters, "-ar", "16000", "-c:a", "aac", "-b:a", "96k", str(output)])
		y = decode(output)
		results.append({"case": name, "policy": policy, **score_signals(reference, noisy, y), "sampleDelta": len(y) - len(reference), "processingSeconds": elapsed})
	print(json.dumps({"case": name, "stoiDeltas": {r["policy"]: round(r["stoiDelta"], 5) for r in results}}), flush=True)
	return results


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("root", type=pathlib.Path)
	parser.add_argument("--reference-ids", nargs=3, required=True)
	args = parser.parse_args()
	root = args.root
	root.mkdir(parents=True, exist_ok=True)
	initial = root.parent.parent
	ids = args.reference_ids
	cases = []
	rng = np.random.default_rng(20260907)
	for index, vid in enumerate(ids):
		x = decode(initial / f"{vid}.m4a")[8 * 16000:28 * 16000]
		x *= 10 ** (-24 / 20) / np.sqrt(np.mean(x ** 2))
		t = np.arange(len(x)) / 16000
		white = rng.normal(size=len(x))
		pink = lfilter([0.049922035, -0.095993537, 0.050612699, -0.004408786], [1, -2.494956002, 2.017265875, -0.5221894], white)
		hum = np.sin(2 * np.pi * 50 * t) + .4 * np.sin(2 * np.pi * 100 * t) + .2 * np.sin(2 * np.pi * 150 * t)
		hiss = lfilter([1, -.95], [1], white)
		cases.append((f"voice{index}-unchanged", x, x.copy()))
		for name, noise in [("white", white), ("fan", pink), ("hum", hum), ("hiss", hiss)]:
			noise /= np.sqrt(np.mean(noise ** 2))
			for snr in [0, 10, 20]:
				noisy = x + noise * np.sqrt(np.mean(x ** 2)) / 10 ** (snr / 20)
				cases.append((f"voice{index}-{name}-snr{snr}", x, noisy))
	results = []
	with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
		for result in pool.map(lambda case: evaluate(case, root), cases):
			results.extend(result)
	(root / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
	main()
