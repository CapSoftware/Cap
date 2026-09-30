import type { VideoMetadata } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import {
	cursorReconstructionBlocker,
	cursorReconstructionPrefix,
	cursorReconstructionView,
	effectiveEditorSources,
} from "@/lib/cursor-reconstruction";
import { parseCursorJobSummary } from "@/lib/cursor-reconstruction-jobs";

const owner = "owner1";
const video = "video1";
const runId = "0123456789abcdef";
const prefix = cursorReconstructionPrefix(owner, video, runId);
const displayKey = `${owner}/${video}/raw-upload.webm`;

function metadata(
	reconstruction: Partial<
		NonNullable<VideoMetadata["cursorReconstruction"]>
	> | null = {},
	sources: Partial<NonNullable<VideoMetadata["editorSources"]>> = {},
): VideoMetadata {
	return {
		editorSources: {
			version: 1,
			display: {
				key: displayKey,
				contentType: "video/webm",
				size: 1000,
				fps: 60,
				objectIdentity: "etag",
			},
			...sources,
		},
		...(reconstruction === null
			? {}
			: {
					cursorReconstruction: {
						version: 1,
						runId,
						jobId: "job",
						status: "ready",
						enabled: true,
						sourceKey: displayKey,
						startedAt: "2026-09-30T00:00:00.000Z",
						display: { key: `${prefix}display.mp4`, size: 500 },
						inputEvents: { key: `${prefix}input-events.ndjson`, size: 20 },
						...reconstruction,
					},
				}),
	} as VideoMetadata;
}

describe("effectiveEditorSources", () => {
	it("swaps in the cleaned display and reconstructed input while enabled", () => {
		const sources = effectiveEditorSources(metadata(), owner, video);
		expect(sources?.display).toEqual({
			key: `${prefix}display.mp4`,
			contentType: "video/mp4",
			size: 500,
			fps: 30,
			objectIdentity: null,
		});
		expect(sources?.inputEvents).toEqual({
			key: `${prefix}input-events.ndjson`,
			contentType: "application/x-ndjson",
			size: 20,
			objectIdentity: null,
		});
	});

	it("keeps the recording as uploaded otherwise", () => {
		for (const input of [
			metadata(null),
			metadata({ enabled: false }),
			metadata({ status: "processing" }),
			metadata({ status: "error" }),
			metadata({ sourceKey: `${owner}/${video}/older.webm` }),
			metadata({ runId: "../other" }),
			metadata({ display: { key: `${owner}/other/display.mp4`, size: 500 } }),
			metadata({
				inputEvents: { key: `${prefix}input-events.ndjson`, size: 0 },
			}),
		]) {
			expect(effectiveEditorSources(input, owner, video)).toBe(
				input.editorSources,
			);
		}
		expect(
			effectiveEditorSources(metadata(), owner, "video2")?.display.key,
		).toBe(displayKey);
	});

	it("never replaces pointer input a recording captured itself", () => {
		const input = metadata(
			{},
			{
				inputEvents: {
					key: `${owner}/${video}/input-events-upload.ndjson`,
					contentType: "application/x-ndjson",
					size: 10,
					objectIdentity: null,
				},
			},
		);
		expect(effectiveEditorSources(input, owner, video)).toBe(
			input.editorSources,
		);
	});
});

describe("cursorReconstructionBlocker", () => {
	it("accepts short browser recordings without pointer input", () => {
		expect(
			cursorReconstructionBlocker({ duration: 299, metadata: metadata(null) }),
		).toBeNull();
	});

	it("rejects long, imported, instrumented and legacy recordings", () => {
		expect(
			cursorReconstructionBlocker({ duration: 301, metadata: metadata(null) }),
		).toMatch(/5 minutes/);
		expect(
			cursorReconstructionBlocker({ duration: null, metadata: metadata(null) }),
		).toMatch(/processing/);
		expect(cursorReconstructionBlocker({ duration: 10, metadata: {} })).toMatch(
			/browser recordings/,
		);
		expect(
			cursorReconstructionBlocker({
				duration: 10,
				metadata: metadata(null, {
					display: {
						key: displayKey,
						contentType: "video/mp4",
						size: 1,
						embeddedAudio: true,
					},
				}),
			}),
		).toMatch(/Imported/);
	});
});

describe("cursorReconstructionView", () => {
	it("reports the current run", () => {
		expect(
			cursorReconstructionView({
				id: video,
				ownerId: owner,
				duration: 60,
				metadata: metadata(),
			}),
		).toEqual({
			eligible: true,
			blocker: null,
			status: "ready",
			enabled: true,
			progress: 1,
			error: null,
			cursorData: true,
		});
		expect(
			cursorReconstructionView({
				id: video,
				ownerId: owner,
				duration: 60,
				metadata: metadata({ status: "processing", progress: 0.4 }),
			}),
		).toMatchObject({
			status: "processing",
			enabled: false,
			progress: 0.4,
			cursorData: false,
		});
	});

	it("treats a run made from an older display as idle", () => {
		expect(
			cursorReconstructionView({
				id: video,
				ownerId: owner,
				duration: 60,
				metadata: metadata({ sourceKey: `${owner}/${video}/older.webm` }),
			}),
		).toMatchObject({ status: "idle", enabled: false });
	});
});

describe("parseCursorJobSummary", () => {
	it("reads a farm summary and drops malformed ones", () => {
		expect(
			parseCursorJobSummary({
				id: "abc",
				status: "ready",
				progress: 1,
				display: `${prefix}display.mp4`,
				inputEvents: `${prefix}input-events.ndjson`,
				bytes: { display: 5, inputEvents: 6 },
			}),
		).toMatchObject({ status: "ready", bytes: { display: 5, inputEvents: 6 } });
		expect(
			parseCursorJobSummary({
				id: "abc",
				status: "ready",
				display: "a",
				inputEvents: "b",
				bytes: { display: 1.5, inputEvents: 6 },
			}),
		).not.toHaveProperty("bytes");
		expect(parseCursorJobSummary({ id: "abc", status: "done" })).toBeNull();
		expect(parseCursorJobSummary(null)).toBeNull();
	});
});
