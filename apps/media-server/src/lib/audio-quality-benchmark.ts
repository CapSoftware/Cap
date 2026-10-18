import { copyFile } from "node:fs/promises";
import type { AudioQualityResult } from "./audio-quality";

export async function retainAudioQualityBenchmarkResult(
	result: AudioQualityResult,
	destination: string,
) {
	if (result.status !== "shadow-candidate") return result;
	try {
		const { cleanup: _cleanup, path: _path, ...evidence } = result;
		if (result.validationFailures.length)
			return { ...evidence, status: "rejected" as const };
		await copyFile(result.path, destination, 1);
		return evidence;
	} finally {
		await result.cleanup();
	}
}
