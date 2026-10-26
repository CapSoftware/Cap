import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	downloadConcatenatedSegments,
	downloadConcatenatedSegmentsToBuffer,
} from "@/lib/segments-audio-download";

describe("segment audio output errors", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "cap-segments-output-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	const delayedFetch: typeof fetch = async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		return new Response("audio segment");
	};

	it("stops reading an oversized streamed segment before buffering its full body", async () => {
		let cancelCount = 0;
		const fetchImpl = (async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(4));
					},
					cancel() {
						cancelCount++;
					},
				}),
			)) as typeof fetch;

		await expect(
			downloadConcatenatedSegmentsToBuffer(["stream"], {
				maxBytes: 7,
				fetchImpl,
			}),
		).rejects.toThrow("Segment audio exceeds 7 bytes");
		expect(cancelCount).toBe(1);
	});

	it("enforces a shared byte limit across parallel streams", async () => {
		const fetchImpl = (async () => new Response(new Uint8Array(5))) as typeof fetch;
		await expect(
			downloadConcatenatedSegmentsToBuffer(["part-1", "part-2"], {
				maxBytes: 8,
				concurrency: 2,
				fetchImpl,
			}),
		).rejects.toThrow("Segment audio exceeds 8 bytes");
	});

	it("rejects a declared oversized segment without downloading it", async () => {
		const fetchImpl = (async () =>
			new Response("unused", {
				headers: { "Content-Length": "201326593" },
			})) as typeof fetch;
		await expect(
			downloadConcatenatedSegments(
				["oversized"],
				join(directory, "output.mp4"),
				{ fetchImpl },
			),
		).rejects.toThrow("Segment audio exceeds 201326592 bytes");
	});

	it("preserves segment order and correct byte totals across parallel downloads", async () => {
		const fetchImpl = (async (url) =>
			new Response(String(url).endsWith("first") ? "first" : "second")) as typeof fetch;
		expect(
			(await downloadConcatenatedSegmentsToBuffer(["first", "second"], {
				concurrency: 2,
				fetchImpl,
			})).toString(),
		).toBe("firstsecond");
	});

	it("rejects an output open failure while a segment is downloading", async () => {
		await expect(
			downloadConcatenatedSegments(
				["https://fixture.invalid/audio.m4s"],
				join(directory, "missing", "audio.mp4"),
				{ fetchImpl: delayedFetch },
			),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.platform !== "linux")(
		"rejects a full output device without emitting an uncaught stream error",
		async () => {
			await expect(
				downloadConcatenatedSegments(
					["https://fixture.invalid/audio.m4s"],
					"/dev/full",
					{ fetchImpl: delayedFetch },
				),
			).rejects.toMatchObject({ code: "ENOSPC" });
		},
	);
});
