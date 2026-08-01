import { describe, expect, it } from "vitest";
import {
	formatTranscriptAsParagraphs,
	type TranscriptTextEntry,
} from "@/lib/transcript-text";

function entry(
	text: string,
	startTime: number,
	endTime: number,
): TranscriptTextEntry {
	return { text, startTime, endTime };
}

describe("formatTranscriptAsParagraphs", () => {
	it("returns an empty string for no entries", () => {
		expect(formatTranscriptAsParagraphs([])).toBe("");
	});

	it("joins caption fragments into one flowing paragraph", () => {
		const result = formatTranscriptAsParagraphs([
			entry("This is my test to make sure that,", 0.9, 2.4),
			entry("the video is working correctly.", 3.0, 4.3),
			entry("I'm going to stop the recording now.", 4.4, 5.8),
		]);
		expect(result).toBe(
			"This is my test to make sure that, the video is working correctly. I'm going to stop the recording now.",
		);
	});

	it("breaks a paragraph at a sentence end followed by a long pause", () => {
		const result = formatTranscriptAsParagraphs([
			entry("First topic ends here.", 0, 2),
			entry("Second topic starts fresh.", 4.5, 6),
		]);
		expect(result).toBe("First topic ends here.\n\nSecond topic starts fresh.");
	});

	it("does not break on a pause mid-sentence", () => {
		const result = formatTranscriptAsParagraphs([
			entry("This sentence keeps", 0, 2),
			entry("going after a pause.", 5, 6),
		]);
		expect(result).toBe("This sentence keeps going after a pause.");
	});

	it("ignores pauses when the entry has no usable end time", () => {
		const result = formatTranscriptAsParagraphs([
			entry("A full sentence.", 2, 2),
			entry("Another sentence.", 10, 11),
		]);
		expect(result).toBe("A full sentence. Another sentence.");
	});

	it("breaks long paragraphs at the next sentence boundary", () => {
		const sentence = `${"word ".repeat(30).trim()}.`;
		const entries = Array.from({ length: 6 }, (_, index) =>
			entry(sentence, index, index + 0.5),
		);
		const result = formatTranscriptAsParagraphs(entries);
		const paragraphs = result.split("\n\n");
		expect(paragraphs.length).toBeGreaterThan(1);
		for (const paragraph of paragraphs) {
			expect(paragraph.endsWith(".")).toBe(true);
		}
	});

	it("hard-breaks transcripts that never end a sentence", () => {
		const fragment = "no punctuation here just words".repeat(3);
		const entries = Array.from({ length: 20 }, (_, index) =>
			entry(fragment, index, index + 0.5),
		);
		const result = formatTranscriptAsParagraphs(entries);
		expect(result.split("\n\n").length).toBeGreaterThan(1);
	});

	it("skips empty fragments", () => {
		const result = formatTranscriptAsParagraphs([
			entry("Hello there.", 0, 1),
			entry("   ", 1, 2),
			entry("General greeting.", 2, 3),
		]);
		expect(result).toBe("Hello there. General greeting.");
	});

	it("respects sentence enders followed by closing quotes", () => {
		const result = formatTranscriptAsParagraphs([
			entry('He said "stop."', 0, 1),
			entry("Then we did.", 4, 5),
		]);
		expect(result).toBe('He said "stop."\n\nThen we did.');
	});
});
