import { expect, test } from "vitest";
import type { EditTranscript } from "../lib/edit-transcript";
import { editTranscriptToEditorCaptions } from "../lib/editor-captions";

function transcript(
	words: Array<{ text: string; startMs: number; endMs: number }>,
): EditTranscript {
	return {
		version: 3,
		speechModelUsed: "universal-3-5-pro",
		durationMs: 60_000,
		languageCode: "en",
		words: words.map((word, index) => ({
			id: `word-${index}`,
			confidence: null,
			speaker: null,
			channel: null,
			...word,
		})),
	};
}

test("AssemblyAI source words become desktop-timed captions without filler or stretched words", () => {
	const result = editTranscriptToEditorCaptions(
		transcript([
			{ text: "This", startMs: 100, endMs: 300 },
			{ text: "is", startMs: 310, endMs: 490 },
			{ text: "um", startMs: 500, endMs: 700 },
			{ text: "a", startMs: 710, endMs: 800 },
			{ text: "test", startMs: 810, endMs: 1000 },
			{ text: ",", startMs: 1000, endMs: 1020 },
			{ text: "of", startMs: 1100, endMs: 1200 },
			{ text: "captions", startMs: 1300, endMs: 18_000 },
		]),
	);
	expect(result.segments).toHaveLength(1);
	expect(result.segments[0]?.text).toBe("This is a test, of captions");
	expect(result.segments[0]?.start).toBe(0.1);
	expect(result.segments[0]?.end).toBe(3.8);
	expect(result.segments[0]?.words).toHaveLength(6);
});

test("caption chunking follows the desktop six-to-eight-word boundary rules", () => {
	const words = [
		"one",
		"two",
		"three",
		"four",
		"five",
		"of",
		"seven",
		"eight",
		"nine",
		"ten",
		"eleven",
		"twelve",
	];
	const result = editTranscriptToEditorCaptions(
		transcript(
			words.map((text, index) => ({
				text,
				startMs: index * 250,
				endMs: index * 250 + 200,
			})),
		),
	);
	expect(result.segments.map((segment) => segment.words.length)).toEqual([
		7, 5,
	]);
	expect(result.segments[0]?.words[6]?.text).toBe("seven");
	expect(result.segments[1]?.start).toBe(1.75);
});

test("late punctuation cannot stretch a spoken word beyond desktop caption timing", () => {
	const result = editTranscriptToEditorCaptions(
		transcript([
			{ text: "Hello", startMs: 100, endMs: 300 },
			{ text: ".", startMs: 4000, endMs: 8000 },
		]),
	);
	expect(result.segments[0]?.text).toBe("Hello.");
	expect(result.segments[0]?.words[0]?.end).toBe(2.6);
	expect(result.segments[0]?.end).toBe(2.6);
});
