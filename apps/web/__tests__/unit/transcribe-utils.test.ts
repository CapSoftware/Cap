import { describe, expect, it } from "vitest";
import { formatTimestamp, formatToWebVTT } from "@/lib/transcribe-utils";
import {
	longVideoDeepgramResponse,
	realDeepgramResponse,
	silentVideoDeepgramResponse,
} from "../fixtures/deepgram-responses";

describe("formatTimestamp", () => {
	it("formats zero correctly", () => {
		expect(formatTimestamp(0)).toBe("00:00:00.000");
	});

	it("formats sub-second timestamps", () => {
		expect(formatTimestamp(0.08)).toBe("00:00:00.080");
		expect(formatTimestamp(0.5)).toBe("00:00:00.500");
		expect(formatTimestamp(0.999)).toBe("00:00:00.999");
	});

	it("formats seconds correctly", () => {
		expect(formatTimestamp(1)).toBe("00:00:01.000");
		expect(formatTimestamp(30.5)).toBe("00:00:30.500");
		expect(formatTimestamp(59.999)).toBe("00:00:59.999");
	});

	it("formats minutes correctly", () => {
		expect(formatTimestamp(60)).toBe("00:01:00.000");
		expect(formatTimestamp(90.25)).toBe("00:01:30.250");
		expect(formatTimestamp(3599.5)).toBe("00:59:59.500");
	});

	it("formats hours correctly", () => {
		expect(formatTimestamp(3600)).toBe("01:00:00.000");
		expect(formatTimestamp(7261.123)).toBe("02:01:01.123");
	});

	it("handles real timestamps from Deepgram", () => {
		const firstWord = realDeepgramResponse.results.utterances[0]?.words[0];
		expect(formatTimestamp(firstWord?.start ?? 0)).toBe("00:00:00.080");
		expect(formatTimestamp(firstWord?.end ?? 0)).toBe("00:00:00.320");
	});
});

describe("formatToWebVTT", () => {
	it("generates valid WebVTT header", () => {
		const result = formatToWebVTT({ results: { utterances: [] } });
		expect(result).toBe("WEBVTT\n\n");
	});

	it("handles null utterances", () => {
		const result = formatToWebVTT({ results: { utterances: null } });
		expect(result).toBe("WEBVTT\n\n");
	});

	it("generates correct VTT from real Deepgram response", () => {
		const vtt = formatToWebVTT(realDeepgramResponse);

		expect(vtt).toMatch(/^WEBVTT\n\n/);
		expect(vtt).toContain("-->");
		expect(vtt).toContain("Hello everyone");
		expect(vtt).toContain("Welcome to this demo video");
	});

	it("creates separate captions for each utterance ending in punctuation", () => {
		const vtt = formatToWebVTT(realDeepgramResponse);

		const captionBlocks = vtt.split("\n\n").filter((block) => block.trim());
		expect(captionBlocks.length).toBeGreaterThan(1);
	});

	it("formats timestamps correctly in VTT format", () => {
		const vtt = formatToWebVTT(realDeepgramResponse);

		const timestampPattern =
			/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/;
		expect(vtt).toMatch(timestampPattern);
	});

	it("handles silent video (no utterances)", () => {
		const vtt = formatToWebVTT(silentVideoDeepgramResponse);
		expect(vtt).toBe("WEBVTT\n\n");
	});

	it("breaks long utterances at 8 words", () => {
		const vtt = formatToWebVTT(longVideoDeepgramResponse);
		const lines = vtt.split("\n");

		const captionTextLines = lines.filter(
			(line) =>
				line.trim() &&
				!line.startsWith("WEBVTT") &&
				!line.includes("-->") &&
				!/^\d+$/.test(line.trim()),
		);

		for (const line of captionTextLines) {
			const wordCount = line.split(" ").length;
			expect(wordCount).toBeLessThanOrEqual(8);
		}
	});

	it("breaks captions at commas", () => {
		const responseWithComma = {
			results: {
				utterances: [
					{
						words: [
							{ word: "First", punctuated_word: "First,", start: 0, end: 0.3 },
							{ word: "then", punctuated_word: "then", start: 0.4, end: 0.6 },
							{
								word: "second",
								punctuated_word: "second.",
								start: 0.7,
								end: 1.0,
							},
						],
					},
				],
			},
		};

		const vtt = formatToWebVTT(responseWithComma);

		expect(vtt).toContain("First");
		expect(vtt).toContain("then second");
	});

	it("breaks captions at long pauses (>0.5s)", () => {
		const responseWithPause = {
			results: {
				utterances: [
					{
						words: [
							{ word: "Before", punctuated_word: "Before", start: 0, end: 0.3 },
							{
								word: "after",
								punctuated_word: "after.",
								start: 1.0,
								end: 1.3,
							},
						],
					},
				],
			},
		};

		const vtt = formatToWebVTT(responseWithPause);
		const captionBlocks = vtt.split("\n\n").filter((b) => b.includes("-->"));

		expect(captionBlocks.length).toBe(2);
	});

	it("preserves caption ordering with sequential numbers", () => {
		const vtt = formatToWebVTT(realDeepgramResponse);
		const lines = vtt.split("\n");

		const captionNumbers = lines
			.filter((line) => /^\d+$/.test(line.trim()))
			.map(Number);

		for (let i = 0; i < captionNumbers.length; i++) {
			expect(captionNumbers[i]).toBe(i + 1);
		}
	});

	it("handles utterance with empty words array", () => {
		const result = formatToWebVTT({
			results: {
				utterances: [{ words: [] }],
			},
		});
		expect(result).toBe("WEBVTT\n\n");
	});

	it("includes remaining words after last punctuation", () => {
		const responseWithTrailingWords = {
			results: {
				utterances: [
					{
						words: [
							{ word: "Hello", punctuated_word: "Hello.", start: 0, end: 0.3 },
							{ word: "Some", punctuated_word: "Some", start: 0.5, end: 0.7 },
							{
								word: "trailing",
								punctuated_word: "trailing",
								start: 0.8,
								end: 1.1,
							},
							{ word: "words", punctuated_word: "words", start: 1.2, end: 1.5 },
						],
					},
				],
			},
		};

		const vtt = formatToWebVTT(responseWithTrailingWords);

		expect(vtt).toContain("Hello");
		expect(vtt).toContain("Some trailing words");
	});
});
