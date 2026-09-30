import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSegmentsAudioExtraction } from "@/lib/segments-audio";
import { downloadConcatenatedSegments } from "@/lib/segments-audio-download";

const completeManifest = {
	version: 5,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [1, 2, 3],
	audio_segments: [1, 2, 3],
	is_complete: true,
};

describe("planSegmentsAudioExtraction", () => {
	it("refuses an incomplete manifest so partial recordings are never transcribed", () => {
		const plan = planSegmentsAudioExtraction({
			...completeManifest,
			is_complete: false,
		});
		expect(plan).toEqual({
			status: "unavailable",
			reason: "manifest is not complete",
		});
	});

	it("allows an incomplete manifest when completeness is not required", () => {
		const plan = planSegmentsAudioExtraction(
			{ ...completeManifest, is_complete: false },
			{ requireComplete: false },
		);
		expect(plan.status).toBe("ok");
	});

	it("reports no-audio only when no audio segments are listed", () => {
		expect(
			planSegmentsAudioExtraction({
				...completeManifest,
				audio_segments: [],
			}),
		).toEqual({ status: "no-audio" });
	});

	it("trusts listed segments over the init flag on completed manifests (v1 reality)", () => {
		// Real version-1 manifests list uploaded audio segments while
		// audio_init_uploaded stays false; absence must be proven by the object
		// store, not the flag.
		const plan = planSegmentsAudioExtraction({
			version: 1,
			video_init_uploaded: true,
			audio_init_uploaded: false,
			video_segments: [1, 2, 3],
			audio_segments: [1, 2, 3],
			is_complete: true,
		});
		expect(plan.status).toBe("ok");
	});

	it("waits for the audio init while the recording is still uploading", () => {
		const plan = planSegmentsAudioExtraction(
			{
				...completeManifest,
				audio_init_uploaded: false,
				is_complete: false,
			},
			{ requireComplete: false },
		);
		expect(plan).toEqual({
			status: "unavailable",
			reason: "audio init not uploaded yet",
		});
	});

	it("normalizes, sorts and dedupes segment entries and sums their durations", () => {
		const plan = planSegmentsAudioExtraction({
			...completeManifest,
			// bare numbers use the 3.0s fallback duration, matching /api/playlist
			audio_segments: [
				{ index: 2, duration: 1.5 },
				3,
				{ index: 2, duration: 9 },
				1,
			],
		});

		expect(plan).toEqual({
			status: "ok",
			entries: [
				{ index: 1, duration: 3.0 },
				{ index: 2, duration: 1.5 },
				{ index: 3, duration: 3.0 },
			],
			totalDurationMs: 7500,
		});
	});

	it("rejects manifests with invalid entries", () => {
		const plan = planSegmentsAudioExtraction({
			...completeManifest,
			audio_segments: [{ index: -1, duration: 2 }],
		});
		expect(plan.status).toBe("unavailable");
	});
});

describe("downloadConcatenatedSegments", () => {
	const outputs: string[] = [];

	const makeOutputPath = () => {
		const path = join(tmpdir(), `segments-audio-test-${Math.random()}.bin`);
		outputs.push(path);
		return path;
	};

	afterEach(async () => {
		await Promise.all(outputs.map((path) => fs.unlink(path).catch(() => {})));
		outputs.length = 0;
	});

	const fetchFromMap =
		(objects: Record<string, string>, delays: Record<string, number> = {}) =>
		async (input: string | URL | Request) => {
			const url = String(input);
			await new Promise((resolve) => setTimeout(resolve, delays[url] ?? 0));
			const body = objects[url];
			if (body === undefined) {
				return { ok: false, status: 404 } as Response;
			}
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () => new TextEncoder().encode(body).buffer,
			} as unknown as Response;
		};

	it("concatenates objects in order even when later fetches resolve first", async () => {
		const outputPath = makeOutputPath();
		const bytes = await downloadConcatenatedSegments(
			["u/init", "u/1", "u/2", "u/3"],
			outputPath,
			{
				fetchImpl: fetchFromMap(
					{ "u/init": "INIT", "u/1": "AAA", "u/2": "BBB", "u/3": "CCC" },
					{ "u/init": 30, "u/1": 20, "u/2": 10, "u/3": 0 },
				),
				concurrency: 4,
			},
		);

		expect(bytes).toBe(13);
		expect(await fs.readFile(outputPath, "utf8")).toBe("INITAAABBBCCC");
	});

	it("throws with the failing segment position when an object is missing", async () => {
		const outputPath = makeOutputPath();
		await expect(
			downloadConcatenatedSegments(["u/init", "u/1", "u/gone"], outputPath, {
				fetchImpl: fetchFromMap({ "u/init": "INIT", "u/1": "AAA" }),
				concurrency: 2,
			}),
		).rejects.toThrow("Segment 2 not accessible: 404");
	});
});
