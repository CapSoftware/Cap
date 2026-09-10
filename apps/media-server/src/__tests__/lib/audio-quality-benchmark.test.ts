import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioQualityResult } from "../../lib/audio-quality";
import { retainAudioQualityBenchmarkResult } from "../../lib/audio-quality-benchmark";

test.each(["accepted", "rejected", "existing"])(
	"benchmark output gate: %s",
	async (mode) => {
		const directory = await mkdtemp(
			join(tmpdir(), "cap-audio-benchmark-test-"),
		);
		const path = join(directory, "candidate.mp4");
		const destination = join(directory, "result.mp4");
		let cleaned = false;
		const measurements = {
			lufs: -20,
			truePeak: -2,
			lra: 4,
			duration: 10,
			channels: 1,
			sampleRate: 48000,
			sampleCount: 480000,
		};
		const result: AudioQualityResult = {
			status: "shadow-candidate",
			path,
			sourceSha256: "source",
			outputSha256: "output",
			input: measurements,
			output: measurements,
			profile: "levels",
			version: "audio-quality-v3",
			peakCorrectionDb: 0,
			validationFailures: mode === "rejected" ? ["excessive-gain"] : [],
			elapsedMs: 1,
			cleanup: async () => {
				cleaned = true;
				await rm(path);
			},
		};
		try {
			await writeFile(path, "processed");
			if (mode === "existing") {
				await writeFile(destination, "original");
				await expect(
					retainAudioQualityBenchmarkResult(result, destination),
				).rejects.toThrow();
				expect(await readFile(destination, "utf8")).toBe("original");
			} else {
				const receipt = await retainAudioQualityBenchmarkResult(
					result,
					destination,
				);
				if (mode === "rejected") {
					expect(receipt).toMatchObject({
						status: "rejected",
						validationFailures: ["excessive-gain"],
					});
					await expect(stat(destination)).rejects.toThrow();
				} else {
					expect(receipt.status).toBe("shadow-candidate");
					expect(await readFile(destination, "utf8")).toBe("processed");
				}
			}
			expect(cleaned).toBe(true);
			await expect(stat(path)).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
