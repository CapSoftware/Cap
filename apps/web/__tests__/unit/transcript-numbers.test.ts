import { describe, expect, it } from "vitest";
import {
	formatTranscriptAsVTT,
	parseVTT,
} from "@/app/s/[videoId]/_components/utils/transcript-utils";
import { formatToWebVTT } from "@/lib/transcribe-utils";
import { updateVttEntryText } from "@/lib/transcript-vtt";

describe("numeric transcript captions", () => {
	it("preserves numbers separated into their own caption by a pause", () => {
		const vtt = formatToWebVTT({
			words: [
				{ text: "The", start: 0, end: 100 },
				{ text: "year", start: 150, end: 300 },
				{ text: "is", start: 350, end: 500 },
				{ text: "2026", start: 1500, end: 1900 },
				{ text: "Next.", start: 3000, end: 3500 },
			],
		});

		expect(parseVTT(vtt).map(({ id, text }) => ({ id, text }))).toEqual([
			{ id: 1, text: "The year is" },
			{ id: 2, text: "2026" },
			{ id: 3, text: "Next." },
		]);
		expect(formatTranscriptAsVTT(parseVTT(vtt))).toContain("\n2026\n");
	});

	it("retains a numeric correction after reparsing the saved transcript", () => {
		const original = formatToWebVTT({
			words: [{ text: "Zero.", start: 0, end: 1000 }],
		});
		const saved = updateVttEntryText(original, 1, "0");

		expect(saved.updated).toBe(true);
		expect(parseVTT(saved.content)).toEqual([
			{ id: 1, text: "0", timestamp: "00:00", startTime: 0 },
		]);
	});

	it("keeps the next caption's ID when an earlier cue has no text", () => {
		const vtt =
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n\n2\n00:00:01.000 --> 00:00:02.000\nHello\n";

		expect(parseVTT(vtt)).toEqual([
			{ id: 2, timestamp: "00:01", startTime: 1, text: "Hello" },
		]);
	});
});
