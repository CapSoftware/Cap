import { describe, expect, it } from "vitest";
import { formatTimestamp, formatToWebVTT } from "@/lib/transcribe-utils";
import {
	longVideoAssemblyAIResponse,
	realAssemblyAIResponse,
	silentVideoAssemblyAIResponse,
} from "../fixtures/assemblyai-responses";

describe("formatTimestamp", () => {
	it("formats zero correctly", () => {
		expect(formatTimestamp(0)).toBe("00:00:00.000");
	});

	it("formats sub-second timestamps", () => {
		expect(formatTimestamp(80)).toBe("00:00:00.080");
		expect(formatTimestamp(500)).toBe("00:00:00.500");
		expect(formatTimestamp(999)).toBe("00:00:00.999");
	});

	it("formats seconds correctly", () => {
		expect(formatTimestamp(1_000)).toBe("00:00:01.000");
		expect(formatTimestamp(30_500)).toBe("00:00:30.500");
		expect(formatTimestamp(59_999)).toBe("00:00:59.999");
	});

	it("formats minutes correctly", () => {
		expect(formatTimestamp(60_000)).toBe("00:01:00.000");
		expect(formatTimestamp(90_250)).toBe("00:01:30.250");
		expect(formatTimestamp(3_599_500)).toBe("00:59:59.500");
	});

	it("formats hours correctly", () => {
		expect(formatTimestamp(3_600_000)).toBe("01:00:00.000");
		expect(formatTimestamp(7_261_123)).toBe("02:01:01.123");
	});

	it("handles AssemblyAI word timestamps", () => {
		const firstWord = realAssemblyAIResponse.words[0];
		expect(formatTimestamp(firstWord?.start ?? 0)).toBe("00:00:00.080");
		expect(formatTimestamp(firstWord?.end ?? 0)).toBe("00:00:00.320");
	});
});

describe("formatToWebVTT", () => {
	it("matches the completed AssemblyAI response shape", () => {
		expect(realAssemblyAIResponse).toMatchObject({
			status: "completed",
			speech_models: ["universal-3-5-pro", "universal-2"],
			speech_model_used: "universal-3-5-pro",
			language_detection: true,
			utterances: null,
		});
		expect(realAssemblyAIResponse.words[0]).toEqual({
			text: "Hello",
			start: 80,
			end: 320,
			confidence: 0.99,
			speaker: null,
		});
	});

	it("generates valid WebVTT header", () => {
		expect(formatToWebVTT({ words: [] })).toBe("WEBVTT\n\n");
	});

	it("handles null words", () => {
		expect(formatToWebVTT({ words: null })).toBe("WEBVTT\n\n");
	});

	it("generates correct VTT from an AssemblyAI response", () => {
		const vtt = formatToWebVTT(realAssemblyAIResponse);

		expect(vtt).toMatch(/^WEBVTT\n\n/);
		expect(vtt).toContain("-->");
		expect(vtt).toContain("Hello everyone.");
		expect(vtt).toContain("Welcome to this demo video.");
	});

	it("creates separate captions at punctuation", () => {
		const vtt = formatToWebVTT(realAssemblyAIResponse);
		const captionBlocks = vtt
			.split("\n\n")
			.filter((block) => block.includes("-->"));

		expect(captionBlocks.length).toBeGreaterThan(1);
	});

	it("formats timestamps correctly in VTT format", () => {
		const vtt = formatToWebVTT(realAssemblyAIResponse);
		const timestampPattern =
			/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/;

		expect(vtt).toMatch(timestampPattern);
	});

	it("handles silent video", () => {
		expect(formatToWebVTT(silentVideoAssemblyAIResponse)).toBe("WEBVTT\n\n");
	});

	it("breaks long captions at eight words", () => {
		const vtt = formatToWebVTT(longVideoAssemblyAIResponse);
		const captionTextLines = vtt
			.split("\n")
			.filter(
				(line) =>
					line.trim() &&
					!line.startsWith("WEBVTT") &&
					!line.includes("-->") &&
					!/^\d+$/.test(line.trim()),
			);

		for (const line of captionTextLines) {
			expect(line.split(" ").length).toBeLessThanOrEqual(8);
		}
	});

	it("breaks captions at commas", () => {
		const vtt = formatToWebVTT({
			words: [
				{ text: "First,", start: 0, end: 300 },
				{ text: "then", start: 400, end: 600 },
				{ text: "second.", start: 700, end: 1_000 },
			],
		});

		expect(vtt).toContain("First,");
		expect(vtt).toContain("then second.");
	});

	it("breaks captions at long pauses", () => {
		const vtt = formatToWebVTT({
			words: [
				{ text: "Before", start: 0, end: 300 },
				{ text: "after.", start: 1_000, end: 1_300 },
			],
		});
		const captionBlocks = vtt
			.split("\n\n")
			.filter((block) => block.includes("-->"));

		expect(captionBlocks).toHaveLength(2);
	});

	it("preserves caption ordering with sequential numbers", () => {
		const lines = formatToWebVTT(realAssemblyAIResponse).split("\n");
		const captionNumbers = lines
			.filter((line) => /^\d+$/.test(line.trim()))
			.map(Number);

		for (let i = 0; i < captionNumbers.length; i++) {
			expect(captionNumbers[i]).toBe(i + 1);
		}
	});

	it("includes remaining words after the last punctuation", () => {
		const vtt = formatToWebVTT({
			words: [
				{ text: "Hello.", start: 0, end: 300 },
				{ text: "Some", start: 500, end: 700 },
				{ text: "trailing", start: 800, end: 1_100 },
				{ text: "words", start: 1_200, end: 1_500 },
			],
		});

		expect(vtt).toContain("Hello.");
		expect(vtt).toContain("Some trailing words");
	});
});
