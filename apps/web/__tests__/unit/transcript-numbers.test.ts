import { describe, expect, it } from "vitest";
import { parseTranscriptVTT } from "@/app/s/[videoId]/_components/utils/parse-transcript-vtt";
import {
	formatTranscriptAsVTT,
	parseVTT,
} from "@/app/s/[videoId]/_components/utils/transcript-utils";
import { formatToWebVTT } from "@/lib/transcribe-utils";
import { updateVttEntryText } from "@/lib/transcript-vtt";

describe.each([
	{ name: "embed", parse: parseVTT },
	{ name: "transcript", parse: parseTranscriptVTT },
])("$name numeric captions", ({ parse }) => {
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

		expect(parse(vtt).map(({ id, text }) => ({ id, text }))).toEqual([
			{ id: 1, text: "The year is" },
			{ id: 2, text: "2026" },
			{ id: 3, text: "Next." },
		]);
		expect(formatTranscriptAsVTT(parse(vtt))).toContain("\n2026\n");
	});

	it.each(["0", "007"])("retains a saved correction to %s", (text) => {
		const original = formatToWebVTT({
			words: [{ text: "Zero.", start: 0, end: 1000 }],
		});
		const saved = updateVttEntryText(original, 1, text);

		expect(saved.updated).toBe(true);
		expect(parse(saved.content)).toMatchObject([
			{ id: 1, text, timestamp: "00:00", startTime: 0 },
		]);
	});

	it("keeps the next caption's ID when an earlier cue has no text", () => {
		const vtt =
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n\n2\n00:00:01.000 --> 00:00:02.000\nHello\n";

		expect(parse(vtt)).toMatchObject([
			{ id: 2, timestamp: "00:01", startTime: 1, text: "Hello" },
		]);
	});
});

it("preserves fractional seek and end times when reloading a saved numeric caption", () => {
	const original = "WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.750\nBond\n";
	const saved = updateVttEntryText(original, 1, "007");

	expect(saved.updated).toBe(true);
	expect(parseTranscriptVTT(saved.content)).toEqual([
		{ id: 1, text: "007", timestamp: "00:01", startTime: 1.5, endTime: 2.75 },
	]);
});
