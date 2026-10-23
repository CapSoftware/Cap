import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadConcatenatedSegments } from "@/lib/segments-audio-download";

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
