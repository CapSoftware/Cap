import type { VideoEditSpec } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
	findActiveTranscriptWordIndex,
	getDeletedTranscriptWordIds,
	groupEditTranscriptWords,
	isFillerWord,
	normalizeTranscriptSelection,
	parseEditTranscript,
	planFillerCuts,
	planTranscriptCut,
	remapEditTranscriptThroughSpec,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { createIdentityEditSpec } from "@/lib/video-edits";
import {
	assemblyAIEditResponse,
	assemblyAIRealFillerResponse,
} from "../fixtures/assemblyai-edit-response";

function editSpec(
	sourceDuration: number,
	keepRanges: { start: number; end: number }[],
): VideoEditSpec {
	return { version: 1, sourceDuration, keepRanges };
}

describe("edit transcript", () => {
	it("normalizes and preserves AssemblyAI word timing", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);

		expect(transcript).toMatchObject({
			version: 3,
			speechModelUsed: "universal-3-5-pro",
			durationMs: 4_000,
			languageCode: "en",
		});
		expect(transcript.words).toHaveLength(9);
		expect(transcript.words[0]).toMatchObject({
			id: "word-0-120-380",
			text: "Um,",
			startMs: 120,
			endMs: 380,
			confidence: 0.98,
			speaker: "A",
			channel: null,
		});
		expect(parseEditTranscript(serializeEditTranscript(transcript))).toEqual(
			transcript,
		);
	});

	it("sorts, clamps, and rejects malformed provider words", () => {
		const transcript = createEditTranscript(
			{
				speech_model_used: "universal-2",
				words: [
					{ text: "second", start: 800, end: 900 },
					{ text: "first", start: -100, end: 250, confidence: 2 },
					{ text: "", start: 300, end: 400 },
					{ text: "invalid", start: Number.NaN, end: 600 },
					{ text: "reverse", start: 700, end: 650, channel: 1 },
					{ text: "outside", start: 1_100, end: 1_200 },
				],
				language_code: null,
			},
			1_000,
		);

		expect(transcript.words.map((word) => word.text)).toEqual([
			"first",
			"reverse",
			"second",
		]);
		expect(transcript.words[0]?.confidence).toBe(1);
		expect(transcript.words[1]?.channel).toBe("1");
	});

	it("records whichever speech model the provider used", () => {
		expect(
			createEditTranscript(
				{ ...assemblyAIEditResponse, speech_model_used: "universal-2" },
				4_000,
			).speechModelUsed,
		).toBe("universal-2");
		expect(
			createEditTranscript(
				{ ...assemblyAIEditResponse, speech_model_used: undefined },
				4_000,
			).speechModelUsed,
		).toBe("unknown");
	});

	it("preserves fillers from the real accuracy regression response", () => {
		const transcript = createEditTranscript(
			assemblyAIRealFillerResponse,
			8_000,
		);

		expect(
			transcript.words
				.filter((word) => isFillerWord(word.text))
				.map(({ text, startMs, endMs, confidence }) => ({
					text,
					startMs,
					endMs,
					confidence,
				})),
		).toEqual([
			{
				text: "um,",
				startMs: 3_460,
				endMs: 3_980,
				confidence: 0.9959265,
			},
			{
				text: "Uh,",
				startMs: 5_760,
				endMs: 7_240,
				confidence: 0.9857637,
			},
		]);
	});

	it("recognizes exact filler variants without substring false positives", () => {
		for (const filler of [
			"um",
			"Umm,",
			"uh",
			"uhhh!",
			"erm",
			"ermm",
			"er",
			"ah",
			"ahh",
			"hmm",
		]) {
			expect(isFillerWord(filler), filler).toBe(true);
		}

		for (const word of [
			"umbrella",
			"term",
			"human",
			"ahead",
			"hammer",
			"m",
			"mhm",
			"huh",
			"uh-huh",
		]) {
			expect(isFillerWord(word), word).toBe(false);
		}
	});

	it("normalizes forward and backward word selections", () => {
		expect(normalizeTranscriptSelection(2, 5, 8)).toEqual({
			startIndex: 2,
			endIndex: 5,
		});
		expect(normalizeTranscriptSelection(5, 2, 8)).toEqual({
			startIndex: 2,
			endIndex: 5,
		});
		expect(normalizeTranscriptSelection(-1, 2, 8)).toBeNull();
		expect(normalizeTranscriptSelection(2, 8, 8)).toBeNull();
	});

	it("uses bounded silence padding for a selected word", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const plan = planTranscriptCut(transcript.words, 6, 6, 4_000);

		expect(plan).toEqual({
			startMs: 2_220,
			endMs: 2_635,
			safe: true,
			reason: null,
		});
	});

	it("marks a cut unsafe when unselected speech overlaps it", () => {
		const transcript = createEditTranscript(
			{
				speech_model_used: "universal-2",
				words: [
					{ text: "speaker one", start: 100, end: 500, speaker: "A" },
					{ text: "um", start: 200, end: 350, speaker: "B" },
					{ text: "continues", start: 520, end: 800, speaker: "A" },
				],
			},
			1_000,
		);

		expect(planTranscriptCut(transcript.words, 1, 1, 1_000)).toEqual({
			startMs: 200,
			endMs: 350,
			safe: false,
			reason: "overlapping-speech",
		});
		expect(planFillerCuts(transcript.words, 1_000)).toEqual({
			ranges: [],
			fillerCount: 1,
			skippedCount: 1,
		});
	});

	it("plans batch filler cuts in chronological order", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const plan = planFillerCuts(transcript.words, 4_000);

		expect(plan).toEqual({
			ranges: [
				{
					startMs: 60,
					endMs: 450,
					safe: true,
					reason: null,
				},
				{
					startMs: 2_220,
					endMs: 2_635,
					safe: true,
					reason: null,
				},
			],
			fillerCount: 2,
			skippedCount: 0,
		});
	});

	it("plans exact safe cuts for the real missing-filler response", () => {
		const transcript = createEditTranscript(
			assemblyAIRealFillerResponse,
			8_000,
		);

		expect(planFillerCuts(transcript.words, transcript.durationMs)).toEqual({
			ranges: [
				{
					startMs: 3_380,
					endMs: 3_980,
					safe: true,
					reason: null,
				},
				{
					startMs: 5_760,
					endMs: 7_240,
					safe: true,
					reason: null,
				},
			],
			fillerCount: 2,
			skippedCount: 0,
		});
	});

	it("groups words linearly and finds the active word with binary search", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const groups = groupEditTranscriptWords(transcript.words, 4);

		expect(groups.map((group) => [group.startIndex, group.endIndex])).toEqual([
			[0, 3],
			[4, 5],
			[6, 8],
		]);
		expect(findActiveTranscriptWordIndex(transcript.words, 750)).toBe(2);
		expect(findActiveTranscriptWordIndex(transcript.words, 2_000)).toBe(-1);
	});

	it("finds an earlier active speaker beneath completed overlapping words", () => {
		const transcript = createEditTranscript(
			{
				speech_model_used: "universal-2",
				words: [
					{ text: "long", start: 0, end: 1_000, speaker: "A" },
					{ text: "short", start: 100, end: 200, speaker: "B" },
					{ text: "later", start: 300, end: 400, speaker: "B" },
				],
			},
			1_200,
		);

		expect(findActiveTranscriptWordIndex(transcript.words, 500)).toBe(0);
	});

	it("derives deleted word presentation from timeline keep ranges", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const deleted = getDeletedTranscriptWordIds(transcript.words, [
			{ start: 0.45, end: 2.22 },
			{ start: 2.635, end: 4 },
		]);

		expect([...deleted]).toEqual(["word-0-120-380", "word-6-2300-2570"]);
	});

	it("handles a 50,000 word transcript without quadratic grouping", () => {
		const transcript = createEditTranscript(
			{
				speech_model_used: "universal-2",
				words: Array.from({ length: 50_000 }, (_, index) => ({
					text: index % 100 === 0 ? "um" : `word${index}`,
					start: index * 300,
					end: index * 300 + 200,
				})),
			},
			15_000_000,
		);

		expect(groupEditTranscriptWords(transcript.words)).toHaveLength(1_042);
		expect(
			planFillerCuts(transcript.words, transcript.durationMs).fillerCount,
		).toBe(500);
		expect(findActiveTranscriptWordIndex(transcript.words, 14_999_900)).toBe(
			49_999,
		);
	});

	it("rejects malformed stored sidecars", () => {
		expect(parseEditTranscript("not json")).toBeNull();
		expect(
			parseEditTranscript(
				JSON.stringify({
					version: 3,
					speechModelUsed: "universal-3-5-pro",
					durationMs: 1000,
					languageCode: "en",
					words: [{ id: "bad", text: "bad", startMs: 900, endMs: 1100 }],
				}),
			),
		).toBeNull();
		expect(
			parseEditTranscript(
				JSON.stringify({
					version: 3,
					speechModelUsed: "",
					durationMs: 1000,
					languageCode: "en",
					words: [],
				}),
			),
		).toBeNull();
	});

	it("rejects sidecars from previous schema versions and accepts any model", () => {
		for (const version of [1, 2]) {
			expect(
				parseEditTranscript(
					JSON.stringify({
						version,
						speechModelUsed: "universal-2",
						durationMs: 1000,
						languageCode: "en",
						words: [],
					}),
				),
			).toBeNull();
		}

		expect(
			parseEditTranscript(
				JSON.stringify({
					version: 3,
					speechModelUsed: "universal-3-5-pro",
					durationMs: 1000,
					languageCode: "en",
					words: [],
				}),
			),
		).toMatchObject({ version: 3, speechModelUsed: "universal-3-5-pro" });
	});
});

describe("remapEditTranscriptThroughSpec", () => {
	it("leaves word timing untouched for an identity spec", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const remapped = remapEditTranscriptThroughSpec(
			transcript,
			createIdentityEditSpec(4),
		);

		expect(remapped.durationMs).toBe(4_000);
		expect(remapped.words).toEqual(transcript.words);
		expect(remapped.speechModelUsed).toBe(transcript.speechModelUsed);
		expect(remapped.languageCode).toBe(transcript.languageCode);
	});

	it("drops words whose midpoint falls inside a cut and shifts the rest", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const remapped = remapEditTranscriptThroughSpec(
			transcript,
			editSpec(4, [
				{ start: 0.45, end: 2.22 },
				{ start: 2.635, end: 4 },
			]),
		);

		expect(remapped.durationMs).toBe(3_135);
		expect(
			remapped.words.map((word) => [word.id, word.startMs, word.endMs]),
		).toEqual([
			["word-1-520-720", 70, 270],
			["word-2-730-840", 280, 390],
			["word-3-850-910", 400, 460],
			["word-4-930-1130", 480, 680],
			["word-5-1140-1510", 690, 1_060],
			["word-7-2700-3070", 1_835, 2_205],
			["word-8-3090-3400", 2_225, 2_535],
		]);
	});

	it("clamps words that straddle a cut boundary instead of dropping them", () => {
		const transcript = createEditTranscript(
			{
				speech_model_used: "universal-3-5-pro",
				words: [
					{ text: "straddles", start: 800, end: 1_400 },
					{ text: "inside", start: 2_000, end: 2_200 },
				],
			},
			4_000,
		);
		const remapped = remapEditTranscriptThroughSpec(
			transcript,
			editSpec(4, [{ start: 1, end: 3 }]),
		);

		expect(remapped.durationMs).toBe(2_000);
		expect(remapped.words).toHaveLength(2);
		// midpoint 1.1s is kept, and the leading 200ms outside the range is clamped
		expect(remapped.words[0]).toMatchObject({
			text: "straddles",
			startMs: 0,
			endMs: 400,
		});
		expect(remapped.words[1]).toMatchObject({
			text: "inside",
			startMs: 1_000,
			endMs: 1_200,
		});
	});

	it("accumulates offsets across multiple keep ranges", () => {
		const transcript = createEditTranscript(
			{
				speech_model_used: "universal-3-5-pro",
				words: [
					{ text: "one", start: 100, end: 300 },
					{ text: "two", start: 2_100, end: 2_400 },
					{ text: "three", start: 4_100, end: 4_500 },
					{ text: "cut", start: 5_200, end: 5_400 },
				],
			},
			6_000,
		);
		const remapped = remapEditTranscriptThroughSpec(
			transcript,
			editSpec(6, [
				{ start: 0, end: 1 },
				{ start: 2, end: 3 },
				{ start: 4, end: 5 },
			]),
		);

		expect(remapped.durationMs).toBe(3_000);
		expect(
			remapped.words.map((word) => [word.text, word.startMs, word.endMs]),
		).toEqual([
			["one", 100, 300],
			["two", 1_100, 1_400],
			["three", 2_100, 2_500],
		]);
	});

	it("preserves ids and word metadata while remapping", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const remapped = remapEditTranscriptThroughSpec(
			transcript,
			editSpec(4, [{ start: 2, end: 4 }]),
		);
		const original = transcript.words.find(
			(word) => word.id === "word-7-2700-3070",
		);
		const moved = remapped.words.find((word) => word.id === "word-7-2700-3070");

		expect(moved).toMatchObject({
			text: original?.text,
			confidence: original?.confidence,
			speaker: original?.speaker,
			channel: original?.channel,
			startMs: 700,
			endMs: 1_070,
		});
	});

	it("drops every word when the spec keeps nothing", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const remapped = remapEditTranscriptThroughSpec(
			transcript,
			editSpec(4, []),
		);

		expect(remapped).toMatchObject({ durationMs: 0, words: [] });
	});

	it("keeps remapped words sorted and parseable", () => {
		const transcript = createEditTranscript(
			assemblyAIRealFillerResponse,
			8_000,
		);
		const remapped = remapEditTranscriptThroughSpec(
			transcript,
			editSpec(8, [
				{ start: 1, end: 3.3 },
				{ start: 4, end: 8 },
			]),
		);

		expect(remapped.durationMs).toBe(6_300);
		for (let index = 1; index < remapped.words.length; index++) {
			const previous = remapped.words[index - 1];
			const current = remapped.words[index];
			expect(current?.startMs).toBeGreaterThanOrEqual(previous?.startMs ?? 0);
			expect(current?.endMs).toBeGreaterThan(current?.startMs ?? 0);
			expect(current?.endMs).toBeLessThanOrEqual(remapped.durationMs);
		}
		expect(parseEditTranscript(serializeEditTranscript(remapped))).toEqual(
			remapped,
		);
	});
});

describe("editTranscriptWordsToCaptionVtt", () => {
	it("strips fillers from captions built off the verbatim words", () => {
		const transcript = createEditTranscript(assemblyAIEditResponse, 4_000);
		const vtt = editTranscriptWordsToCaptionVtt(transcript.words);

		expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
		expect(vtt).not.toContain("Um,");
		expect(vtt).not.toContain("Erm");
		expect(vtt).toContain("this is a real example.");
		expect(vtt).toContain("00:00:00.520 --> 00:00:01.510");
		expect(vtt).toContain("nothing else.");
	});

	it("returns a header-only VTT when there are no words", () => {
		expect(editTranscriptWordsToCaptionVtt([])).toBe("WEBVTT\n\n");
	});
});
