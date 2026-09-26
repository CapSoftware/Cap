import { describe, expect, test } from "bun:test";
import {
	checkManifestBounds,
	sourceLimitsFromEnv,
	validateJobRequest,
} from "./validate";

describe("validateJobRequest", () => {
	test("accepts a typical export", () => {
		const request = {
			recording: "recordings/abc123",
			fps: 30,
			resolution: [1920, 1080] as [number, number],
			compression: "Maximum" as const,
		};
		expect(validateJobRequest(request)).toEqual(request);
	});

	test.each([
		[null, "body must be a JSON object"],
		[{}, "recording must be a bucket prefix"],
		[{ recording: "../secrets" }, "recording must be a bucket prefix"],
		[{ recording: "a/../../b" }, "recording must be a bucket prefix"],
		[{ recording: "rec", fps: 0 }, "fps must be an integer from 1 to 120"],
		[{ recording: "rec", fps: 29.97 }, "fps must be an integer from 1 to 120"],
		[{ recording: "rec", resolution: [99999, 1080] }, "resolution"],
		[{ recording: "rec", resolution: [1920] }, "resolution"],
		[
			{ recording: "rec", compression: "Lossless" },
			"compression must be one of",
		],
		[
			{ recording: "rec", compression: "toString" },
			"compression must be one of",
		],
		[{ recording: "rec", maxChunks: -1 }, "maxChunks"],
		[{ recording: "rec", chunks: 5000 }, "chunks"],
		[{ recording: "rec", chunkWorkSeconds: Number.NaN }, "chunkWorkSeconds"],
		[{ recording: "rec", label: "x".repeat(201) }, "label"],
	])("rejects %j", (body, message) => {
		const result = validateJobRequest(body);
		expect(typeof result).toBe("string");
		expect(result as string).toContain(message);
	});
});

describe("checkManifestBounds", () => {
	const limits = {
		...sourceLimitsFromEnv({}),
		files: 4,
		sourceBytes: 1000,
		sidecarBytes: 100,
	};
	const file = (path: string, size: number) => ({ path, size });

	test("accepts a manifest within its limits", () => {
		expect(
			checkManifestBounds(
				{
					files: [
						file("recording-meta.json", 50),
						file("content/segments/segment-0/display.mp4", 800),
						file("content/segments/segment-0/audio-input.ogg", 120),
					],
				},
				limits,
			),
		).toBeNull();
	});

	test.each([
		[{}, "no files list"],
		[
			{ files: Array.from({ length: 5 }, (_, i) => file(`${i}.json`, 1)) },
			"5 files",
		],
		[
			{ files: [file("display.mp4", 999), file("camera.mp4", 2)] },
			"recording is 1001 bytes",
		],
		[{ files: [file("cursors/0.png", 101)] }, "cursors/0.png is 101 bytes"],
		[{ files: [file("display.mp4", -1)] }, "non-negative integer"],
		[{ files: [file("display.mp4", Number.NaN)] }, "non-negative integer"],
		[{ files: [{ path: "", size: 1 }] }, "manifest paths"],
		[{ files: [{ path: "a.json", size: 1, key: 5 }] }, "manifest key"],
		[{ files: [null] }, "not an object"],
	])("rejects %j", (manifest, message) => {
		expect(checkManifestBounds(manifest, limits)).toContain(message);
	});

	test("large video and audio files are bounded only by the total", () => {
		expect(
			checkManifestBounds(
				{ files: [file("display.mp4", 600), file("audio-input.ogg", 300)] },
				limits,
			),
		).toBeNull();
	});

	test("environment overrides apply only to valid positive numbers", () => {
		const parsed = sourceLimitsFromEnv({
			RF_MAX_SOURCE_FILES: "10",
			RF_MAX_SOURCE_BYTES: "-5",
			RF_MAX_EXPORT_SECONDS: "abc",
		});
		expect(parsed.files).toBe(10);
		expect(parsed.sourceBytes).toBe(256 * 2 ** 30);
		expect(parsed.exportSeconds).toBe(4 * 3600);
	});
});
