import { describe, expect, it } from "vitest";
import {
	applyChunkToLiveTranscript,
	canPromoteLiveTranscript,
	createEmptyLiveTranscript,
	isNoSpokenAudioError,
	liveTranscriptToEditTranscript,
	offsetChunkWords,
	parseLiveTranscript,
	planNextLiveChunk,
} from "@/lib/live-transcribe-core";

const baseManifest = {
	version: 5,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [] as (number | { index: number; duration: number })[],
	audio_segments: [] as (number | { index: number; duration: number })[],
	is_complete: false,
};

const seg = (index: number, duration = 2) => ({ index, duration });

describe("planNextLiveChunk", () => {
	it("waits while there is not enough new audio for a chunk", () => {
		const decision = planNextLiveChunk({
			manifest: {
				...baseManifest,
				audio_segments: [seg(1), seg(2), seg(3)],
			},
			lastProcessedIndex: 0,
			targetSeconds: 15,
		});
		expect(decision).toEqual({ action: "wait" });
	});

	it("emits a chunk once the window target is reached, with the right offset", () => {
		const decision = planNextLiveChunk({
			manifest: {
				...baseManifest,
				audio_segments: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => seg(i)),
			},
			lastProcessedIndex: 2,
			targetSeconds: 10,
		});

		expect(decision).toMatchObject({
			action: "chunk",
			startMs: 4000,
			durationMs: 12000,
		});
		if (decision.action === "chunk") {
			expect(decision.entries.map((entry) => entry.index)).toEqual([
				3, 4, 5, 6, 7, 8,
			]);
		}
	});

	it("emits the remainder immediately once the manifest is complete", () => {
		const decision = planNextLiveChunk({
			manifest: {
				...baseManifest,
				audio_segments: [seg(1), seg(2), seg(3)],
				is_complete: true,
			},
			lastProcessedIndex: 2,
			targetSeconds: 15,
		});
		expect(decision).toMatchObject({
			action: "chunk",
			startMs: 4000,
			durationMs: 2000,
		});
	});

	it("caps how much audio one chunk may take when catching up", () => {
		const decision = planNextLiveChunk({
			manifest: {
				...baseManifest,
				audio_segments: Array.from({ length: 60 }, (_, i) => seg(i + 1)),
			},
			lastProcessedIndex: 0,
			targetSeconds: 15,
			maxTakeSeconds: 20,
		});
		expect(decision).toMatchObject({ action: "chunk", durationMs: 20000 });
	});

	it("never reads past a segment index gap", () => {
		const decision = planNextLiveChunk({
			manifest: {
				...baseManifest,
				// segment 3 missing: only 1..2 may be considered
				audio_segments: [
					seg(1),
					seg(2),
					seg(4),
					seg(5),
					seg(6),
					seg(7),
					seg(8),
				],
				is_complete: true,
			},
			lastProcessedIndex: 0,
			targetSeconds: 2,
		});
		expect(decision).toMatchObject({
			action: "chunk",
			startMs: 0,
			durationMs: 4000,
		});
		if (decision.action === "chunk") {
			expect(decision.entries.map((entry) => entry.index)).toEqual([1, 2]);
		}
	});

	it("transcribes segment 0 of a 0-based manifest from the fresh-cursor sentinel", () => {
		const decision = planNextLiveChunk({
			manifest: {
				...baseManifest,
				audio_segments: [seg(0), seg(1), seg(2)],
				is_complete: true,
			},
			lastProcessedIndex: -1,
			targetSeconds: 15,
		});
		expect(decision).toMatchObject({
			action: "chunk",
			startMs: 0,
			durationMs: 6000,
		});
		if (decision.action === "chunk") {
			expect(decision.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
		}
	});

	it("finishes when a completed manifest has nothing contiguous left", () => {
		expect(
			planNextLiveChunk({
				manifest: {
					...baseManifest,
					audio_segments: [seg(1), seg(2), seg(4)],
					is_complete: true,
				},
				lastProcessedIndex: 2,
				targetSeconds: 15,
			}),
		).toEqual({ action: "done" });
	});

	it("reports no-audio only for completed manifests", () => {
		expect(
			planNextLiveChunk({
				manifest: { ...baseManifest, is_complete: true },
				lastProcessedIndex: 0,
				targetSeconds: 15,
			}),
		).toEqual({ action: "no-audio" });
		expect(
			planNextLiveChunk({
				manifest: baseManifest,
				lastProcessedIndex: 0,
				targetSeconds: 15,
			}),
		).toEqual({ action: "wait" });
	});
});

describe("offsetChunkWords", () => {
	it("offsets, clamps and filters words onto the recording timeline", () => {
		const words = offsetChunkWords(
			[
				{ text: "hello", start: 100, end: 500, confidence: 0.9 },
				{ text: "world", start: 500, end: 99999, speaker: "A" },
				{ text: "", start: 0, end: 100 },
				{ text: "bad", start: null as unknown as number, end: 100 },
			],
			10_000,
			4_000,
		);

		expect(words).toHaveLength(2);
		expect(words[0]).toMatchObject({
			text: "hello",
			startMs: 10_100,
			endMs: 10_500,
			confidence: 0.9,
		});
		// end clamped to the chunk bound
		expect(words[1]).toMatchObject({
			text: "world",
			startMs: 10_500,
			endMs: 14_000,
			speaker: "A",
		});
	});
});

describe("live transcript artifact", () => {
	it("applies chunks idempotently and renders captions", () => {
		const empty = createEmptyLiveTranscript("2026-08-03T00:00:00.000Z");

		const chunk1 = applyChunkToLiveTranscript(empty, {
			startMs: 0,
			durationMs: 4000,
			lastAudioSegmentIndex: 2,
			words: offsetChunkWords([{ text: "First", start: 0, end: 900 }], 0, 4000),
			languageCode: "en",
			nowIso: "2026-08-03T00:00:05.000Z",
		});

		const chunk2 = {
			startMs: 4000,
			durationMs: 4000,
			lastAudioSegmentIndex: 4,
			words: offsetChunkWords(
				[{ text: "second", start: 200, end: 1000 }],
				4000,
				4000,
			),
			languageCode: "en" as const,
			nowIso: "2026-08-03T00:00:09.000Z",
		};

		const applied = applyChunkToLiveTranscript(chunk1, chunk2);
		// retrying the same chunk must not duplicate words
		const reapplied = applyChunkToLiveTranscript(applied, chunk2);

		expect(reapplied.words.map((word) => word.text)).toEqual([
			"First",
			"second",
		]);
		expect(reapplied.lastAudioSegmentIndex).toBe(4);
		expect(reapplied.transcribedDurationMs).toBe(8000);
		expect(reapplied.languageCode).toBe("en");
		expect(reapplied.vtt.startsWith("WEBVTT")).toBe(true);
		expect(reapplied.vtt).toContain("First");
		expect(reapplied.vtt).toContain("second");

		const roundTripped = parseLiveTranscript(JSON.stringify(reapplied));
		expect(roundTripped).toEqual(reapplied);
	});

	it("rejects malformed artifacts", () => {
		expect(parseLiveTranscript("not json")).toBeNull();
		expect(parseLiveTranscript(JSON.stringify({ version: 99 }))).toBeNull();
	});
});

describe("canPromoteLiveTranscript", () => {
	const fullCoverage = (overrides = {}) => ({
		...createEmptyLiveTranscript("2026-08-03T00:00:00.000Z"),
		lastAudioSegmentIndex: 3,
		transcribedDurationMs: 6000,
		...overrides,
	});
	const completeManifest = {
		...baseManifest,
		audio_segments: [seg(1), seg(2), seg(3)],
		is_complete: true,
	};

	it("promotes only full gap-free coverage", () => {
		expect(canPromoteLiveTranscript(fullCoverage(), completeManifest)).toEqual({
			ok: true,
		});
	});

	it("declines incomplete manifests, partial coverage, and skipped chunks", () => {
		expect(
			canPromoteLiveTranscript(fullCoverage(), {
				...completeManifest,
				is_complete: false,
			}).ok,
		).toBe(false);
		expect(
			canPromoteLiveTranscript(
				fullCoverage({ lastAudioSegmentIndex: 2 }),
				completeManifest,
			).ok,
		).toBe(false);
		expect(
			canPromoteLiveTranscript(
				fullCoverage({ hasGaps: true }),
				completeManifest,
			).ok,
		).toBe(false);
	});

	it("declines manifests with segment index gaps", () => {
		expect(
			canPromoteLiveTranscript(fullCoverage({ lastAudioSegmentIndex: 4 }), {
				...completeManifest,
				audio_segments: [seg(1), seg(2), seg(4)],
			}).ok,
		).toBe(false);
	});

	it("declines recordings with no audio", () => {
		expect(
			canPromoteLiveTranscript(fullCoverage(), {
				...completeManifest,
				audio_segments: [],
			}).ok,
		).toBe(false);
	});
});

describe("liveTranscriptToEditTranscript", () => {
	it("shapes accumulated words as a canonical v3 edit transcript", () => {
		const artifact = applyChunkToLiveTranscript(
			createEmptyLiveTranscript("2026-08-03T00:00:00.000Z"),
			{
				startMs: 0,
				durationMs: 4000,
				lastAudioSegmentIndex: 2,
				words: offsetChunkWords(
					[{ text: "Hello", start: 10, end: 500 }],
					0,
					4000,
				),
				languageCode: "en",
				nowIso: "2026-08-03T00:00:05.000Z",
			},
		);

		const edit = liveTranscriptToEditTranscript(artifact, "universal-3-5-pro");
		expect(edit).toMatchObject({
			version: 3,
			speechModelUsed: "universal-3-5-pro",
			durationMs: 4000,
			languageCode: "en",
		});
		expect(edit.words).toHaveLength(1);
		expect(edit.words[0]).toMatchObject({ text: "Hello", startMs: 10 });
	});
});

describe("isNoSpokenAudioError", () => {
	it("recognizes speech-free chunks as valid empties, not failures", () => {
		// exact message observed from the real API on a silent recording
		expect(
			isNoSpokenAudioError({
				status: "error",
				error:
					"language_detection cannot be performed on files with no spoken audio.",
			}),
		).toBe(true);
		expect(
			isNoSpokenAudioError({ status: "error", error: "Server error" }),
		).toBe(false);
		expect(isNoSpokenAudioError({ status: "completed" })).toBe(false);
	});
});
