import { describe, expect, it } from "vitest";
import {
	parseEditTranscript,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
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

describe("live chunks with context", () => {
	it("sends the trailing transcribed segments as context, none for the first chunk", () => {
		const manifest = {
			...baseManifest,
			audio_segments: Array.from({ length: 20 }, (_, i) => seg(i + 1)),
		};
		const first = planNextLiveChunk({
			manifest,
			lastProcessedIndex: 0,
			targetSeconds: 4,
			maxTakeSeconds: 4,
			contextSeconds: 5,
		});
		expect(first).toMatchObject({ action: "chunk", contextMs: 0, context: [] });

		const later = planNextLiveChunk({
			manifest,
			lastProcessedIndex: 10,
			targetSeconds: 4,
			maxTakeSeconds: 4,
			contextSeconds: 5,
		});
		expect(later).toMatchObject({
			action: "chunk",
			startMs: 20_000,
			contextMs: 6000,
		});
		if (later.action === "chunk") {
			expect(later.context.map((entry) => entry.index)).toEqual([8, 9, 10]);
			expect(later.entries.map((entry) => entry.index)).toEqual([11, 12]);
		}

		const without = planNextLiveChunk({
			manifest,
			lastProcessedIndex: 10,
			targetSeconds: 4,
			maxTakeSeconds: 4,
		});
		expect(without).toMatchObject({
			action: "chunk",
			contextMs: 0,
			context: [],
		});
	});

	it("places context words before the chunk start", () => {
		const words = offsetChunkWords(
			[
				{ text: "old", start: 1000, end: 1400 },
				{ text: "edge", start: 3900, end: 4300 },
				{ text: "cut", start: 5900, end: 6300 },
				{ text: "new", start: 6500, end: 6900 },
			],
			20_000,
			4000,
			6000,
		);
		expect(words.map((word) => [word.text, word.startMs, word.endMs])).toEqual([
			["old", 15_000, 15_400],
			["edge", 17_900, 18_300],
			["cut", 19_900, 20_300],
			["new", 20_500, 20_900],
		]);
	});

	it("never hands over more than the context actually sent", () => {
		const words = offsetChunkWords(
			[
				{ text: "early", start: 0, end: 300 },
				{ text: "inside", start: 600, end: 900 },
				{ text: "new", start: 1200, end: 1500 },
			],
			10_000,
			4000,
			1000,
		);
		expect(words.map((word) => [word.text, word.startMs])).toEqual([
			["early", 9000],
			["inside", 9600],
			["new", 10_200],
		]);
	});

	it("replaces the previous chunk's cut-off tail and stays idempotent", () => {
		const empty = createEmptyLiveTranscript("2026-10-28T00:00:00.000Z");
		const first = applyChunkToLiveTranscript(empty, {
			startMs: 0,
			durationMs: 10_000,
			lastAudioSegmentIndex: 5,
			words: offsetChunkWords(
				[
					{ text: "kept", start: 7000, end: 7500 },
					{ text: "garbled", start: 9800, end: 10_000 },
				],
				0,
				10_000,
			),
			languageCode: "en",
			nowIso: "2026-10-28T00:00:10.000Z",
		});
		const second = {
			startMs: 10_000,
			durationMs: 10_000,
			contextMs: 10_000,
			lastAudioSegmentIndex: 10,
			words: offsetChunkWords(
				[
					{ text: "kept", start: 7000, end: 7500 },
					{ text: "whole", start: 9800, end: 10_300 },
					{ text: "next", start: 11_000, end: 11_400 },
				],
				10_000,
				10_000,
				10_000,
			),
			languageCode: "en",
			nowIso: "2026-10-28T00:00:20.000Z",
		};
		const applied = applyChunkToLiveTranscript(first, second);
		const reapplied = applyChunkToLiveTranscript(applied, second);
		expect(reapplied.words.map((word) => word.text)).toEqual([
			"kept",
			"whole",
			"next",
		]);
		expect(reapplied.transcribedDurationMs).toBe(20_000);
	});

	const contextChunk = (
		startMs: number,
		words: { text: string; start: number; end: number }[],
	) => ({
		startMs,
		durationMs: 10_000,
		contextMs: 10_000,
		lastAudioSegmentIndex: 10,
		words: offsetChunkWords(words, startMs, 10_000, 10_000),
		languageCode: "en",
		nowIso: "2026-10-28T00:00:20.000Z",
	});
	const firstChunk = (words: { text: string; start: number; end: number }[]) =>
		applyChunkToLiveTranscript(
			createEmptyLiveTranscript("2026-10-28T00:00:00.000Z"),
			{
				startMs: 0,
				durationMs: 10_000,
				lastAudioSegmentIndex: 5,
				words: offsetChunkWords(words, 0, 10_000),
				languageCode: "en",
				nowIso: "2026-10-28T00:00:10.000Z",
			},
		);

	it("keeps one copy of a word the two chunks time either side of the handover", () => {
		for (const [previousStart, nextStart] of [
			[7990, 8010],
			[8010, 7990],
		] as const) {
			const first = firstChunk([
				{ text: "before", start: 7400, end: 7800 },
				{ text: "word", start: previousStart, end: previousStart + 300 },
				{ text: "after,", start: 8500, end: 8900 },
			]);
			const merged = applyChunkToLiveTranscript(
				first,
				contextChunk(10_000, [
					{ text: "before", start: 7410, end: 7810 },
					{ text: "word", start: nextStart, end: nextStart + 300 },
					{ text: "after", start: 8520, end: 8900 },
					{ text: "next", start: 11_000, end: 11_400 },
				]),
			);
			expect(merged.words.map((word) => word.text)).toEqual([
				"before",
				"word",
				"after",
				"next",
			]);
		}
	});

	it("keeps both copies of a word repeated at the handover", () => {
		for (const shift of [0, 120, -120]) {
			const first = firstChunk([
				{ text: "say", start: 7400, end: 7700 },
				{ text: "no,", start: 7800, end: 7950 },
				{ text: "no", start: 8000, end: 8150 },
				{ text: "way", start: 8500, end: 8800 },
			]);
			const merged = applyChunkToLiveTranscript(
				first,
				contextChunk(10_000, [
					{ text: "say", start: 7400 + shift, end: 7700 + shift },
					{ text: "no,", start: 7800 + shift, end: 7950 + shift },
					{ text: "no", start: 8000 + shift, end: 8150 + shift },
					{ text: "way", start: 8500 + shift, end: 8800 + shift },
					{ text: "next", start: 11_000, end: 11_400 },
				]),
			);
			expect(merged.words.map((word) => word.text)).toEqual([
				"say",
				"no,",
				"no",
				"way",
				"next",
			]);
		}
	});

	it("keeps every copy of a word repeated several times across the handover", () => {
		const said = [
			{ text: "say", start: 7300, end: 7500 },
			{ text: "no,", start: 7600, end: 7750 },
			{ text: "no,", start: 7800, end: 7950 },
			{ text: "no,", start: 8000, end: 8150 },
			{ text: "no", start: 8200, end: 8350 },
			{ text: "way", start: 8500, end: 8800 },
		];
		for (const shift of [0, 90, -90, 140, -140]) {
			const first = firstChunk(said);
			const merged = applyChunkToLiveTranscript(
				first,
				contextChunk(10_000, [
					...said.map((word) => ({
						...word,
						start: word.start + shift,
						end: word.end + shift,
					})),
					{ text: "next", start: 11_000, end: 11_400 },
				]),
			);
			expect(merged.words.map((word) => word.text)).toEqual([
				...said.map((word) => word.text),
				"next",
			]);
		}
	});

	it("keeps a promoted transcript readable when a join reorders word times", () => {
		const first = firstChunk([
			{ text: "the", start: 7850, end: 7990 },
			{ text: "word", start: 8000, end: 8300 },
		]);
		const merged = applyChunkToLiveTranscript(
			first,
			contextChunk(10_000, [
				{ text: "the", start: 7650, end: 7790 },
				{ text: "word", start: 7800, end: 8100 },
				{ text: "next", start: 11_000, end: 11_400 },
			]),
		);
		expect(merged.words.map((word) => word.text)).toEqual([
			"the",
			"word",
			"next",
		]);
		const starts = merged.words.map((word) => word.startMs);
		expect(starts).toEqual([...starts].sort((a, b) => a - b));
		expect(
			parseEditTranscript(
				serializeEditTranscript(
					liveTranscriptToEditTranscript(merged, "universal-3-5-pro"),
				),
			),
		).not.toBeNull();
	});

	it("gives words clamped to a chunk's end a length", () => {
		const artifact = applyChunkToLiveTranscript(
			createEmptyLiveTranscript("2026-10-28T00:00:00.000Z"),
			{
				startMs: 0,
				durationMs: 4000,
				lastAudioSegmentIndex: 2,
				words: offsetChunkWords(
					[
						{ text: "last", start: 3900, end: 4000 },
						{ text: "beyond", start: 4100, end: 4300 },
					],
					0,
					4000,
				),
				languageCode: "en",
				nowIso: "2026-10-28T00:00:05.000Z",
			},
		);
		expect(artifact.words.map((word) => word.text)).toEqual(["last", "beyond"]);
		for (const word of artifact.words) {
			expect(word.endMs).toBeGreaterThan(word.startMs);
			expect(word.endMs).toBeLessThanOrEqual(4000);
		}
		expect(
			parseEditTranscript(
				serializeEditTranscript(
					liveTranscriptToEditTranscript(artifact, "universal-3-5-pro"),
				),
			),
		).not.toBeNull();
	});

	it("cuts at the handover when the chunks share no word near it", () => {
		const first = firstChunk([
			{ text: "alpha", start: 6800, end: 7700 },
			{ text: "garbled", start: 8100, end: 9900 },
		]);
		const merged = applyChunkToLiveTranscript(
			first,
			contextChunk(10_000, [
				{ text: "alfa", start: 6850, end: 7650 },
				{ text: "bravo", start: 8100, end: 8600 },
				{ text: "charlie", start: 8700, end: 10_400 },
			]),
		);
		expect(merged.words.map((word) => word.text)).toEqual([
			"alpha",
			"bravo",
			"charlie",
		]);
	});

	it("rebuilds a recording exactly when cut words are heard again with context", () => {
		// A word every 400 ms; the provider garbles words cut by the audio's end
		// and words in the first second of audio that starts mid-recording, and
		// each call times words up to 150 ms differently.
		const truth = Array.from({ length: 150 }, (_, i) => ({
			text: `w${i}`,
			start: i * 400 + 50,
			end: i * 400 + 350,
		}));
		const manifest = {
			...baseManifest,
			audio_segments: Array.from({ length: 30 }, (_, i) => seg(i + 1, 2)),
			is_complete: true,
		};
		const jitter = (startMs: number, fromMs: number) =>
			((startMs * 7919 + fromMs * 104_729) % 301) - 150;
		const transcribe = (fromMs: number, toMs: number) =>
			truth
				.filter((word) => word.start >= fromMs && word.start < toMs)
				.map((word) => ({
					text:
						word.end > toMs || (fromMs > 0 && word.start < fromMs + 1000)
							? "garbled"
							: word.text,
					start: word.start - fromMs + jitter(word.start, fromMs),
					end: Math.min(word.end, toMs) - fromMs + jitter(word.start, fromMs),
				}));

		const run = (contextSeconds: number) => {
			let artifact = createEmptyLiveTranscript("2026-10-28T00:00:00.000Z");
			let last = 0;
			for (;;) {
				const decision = planNextLiveChunk({
					manifest,
					lastProcessedIndex: last,
					targetSeconds: 10,
					maxTakeSeconds: 10,
					contextSeconds,
				});
				if (decision.action !== "chunk") break;
				const fromMs = decision.startMs - decision.contextMs;
				artifact = applyChunkToLiveTranscript(artifact, {
					startMs: decision.startMs,
					durationMs: decision.durationMs,
					contextMs: decision.contextMs,
					lastAudioSegmentIndex: decision.entries.at(-1)?.index ?? last,
					words: offsetChunkWords(
						transcribe(fromMs, decision.startMs + decision.durationMs),
						decision.startMs,
						decision.durationMs,
						decision.contextMs,
					),
					languageCode: "en",
					nowIso: "2026-10-28T00:01:00.000Z",
				});
				last = decision.entries.at(-1)?.index ?? last;
			}
			expect(
				parseEditTranscript(
					serializeEditTranscript(
						liveTranscriptToEditTranscript(artifact, "universal-3-5-pro"),
					),
				),
			).not.toBeNull();
			return artifact.words;
		};

		const withContext = run(20);
		expect(withContext.map((word) => word.text)).toEqual(
			truth.map((word) => word.text),
		);
		for (const [index, word] of withContext.entries()) {
			expect(
				Math.abs(word.startMs - (truth[index]?.start ?? 0)),
			).toBeLessThanOrEqual(150);
		}
		expect(run(0).some((word) => word.text === "garbled")).toBe(true);
	});
});
