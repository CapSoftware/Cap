import { describe, expect, test } from "bun:test";
import { validateJobRequest } from "./validate";

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
