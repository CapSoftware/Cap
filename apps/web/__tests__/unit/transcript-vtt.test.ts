import { describe, expect, it } from "vitest";
import {
	normalizeTranscriptCueText,
	updateVttEntryText,
} from "@/lib/transcript-vtt";

const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:02.959
To bulk import Loom videos via CSV.

2
00:00:03.199 --> 00:00:05.359
So you can drag and drop the template
across multiple payload lines

3
00:00:05.359 --> 00:00:06.080
into,`;

describe("normalizeTranscriptCueText", () => {
	it("collapses whitespace inside edited caption text", () => {
		expect(normalizeTranscriptCueText("  hello\n\nthere\tfriend  ")).toBe(
			"hello there friend",
		);
	});
});

describe("updateVttEntryText", () => {
	it("updates only the requested cue text without changing timings", () => {
		const result = updateVttEntryText(vtt, 1, "Updated first caption");

		expect(result.updated).toBe(true);
		expect(result.content).toContain(
			"1\n00:00:00.000 --> 00:00:02.959\nUpdated first caption",
		);
		expect(result.content).toContain(
			"2\n00:00:03.199 --> 00:00:05.359\nSo you can drag and drop the template\nacross multiple payload lines",
		);
	});

	it("replaces an existing multi-line cue payload as one sanitized caption", () => {
		const result = updateVttEntryText(
			vtt,
			2,
			"Replacement\ncaption\nwith pasted spacing",
		);

		expect(result.updated).toBe(true);
		expect(result.content).toContain(
			"2\n00:00:03.199 --> 00:00:05.359\nReplacement caption with pasted spacing",
		);
		expect(result.content).not.toContain("across multiple payload lines");
	});

	it("leaves the file unchanged when the cue id does not exist", () => {
		const result = updateVttEntryText(vtt, 99, "Missing caption");

		expect(result.updated).toBe(false);
		expect(result.content).toBe(vtt);
	});
});
