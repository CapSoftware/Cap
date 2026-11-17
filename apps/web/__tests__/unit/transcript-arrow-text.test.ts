import { describe, expect, it } from "vitest";
import { parseTranscriptVTT } from "@/app/s/[videoId]/_components/utils/parse-transcript-vtt";
import { updateVttEntryText } from "@/lib/transcript-vtt";

describe("share transcript arrow text", () => {
	const parse = parseTranscriptVTT;

	it.each([
		"Read A --> B",
		"a-->b",
		"--> begins the caption",
		"00:00:01.000 --> output value",
	])("preserves %s as caption text", (text) => {
		const vtt = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n${text}\n\n2\n00:00:03.000 --> 00:00:04.000\nNext caption\n`;
		expect(parse(vtt)).toMatchObject([
			{ id: 1, startTime: 1, text },
			{ id: 2, startTime: 3, text: "Next caption" },
		]);
	});

	it("recognizes the next timing line when an empty cue has no blank separator", () => {
		const vtt =
			"WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n00:00:03.000 --> 00:00:04.000\nNext caption\n";
		expect(parse(vtt)).toMatchObject([
			{ id: 1, startTime: 3, text: "Next caption" },
		]);
	});

	it("retains an edited arrow caption after reloading the saved VTT", () => {
		const original = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nOriginal\n";
		const saved = updateVttEntryText(original, 1, "Use A --> B");
		expect(saved.updated).toBe(true);
		expect(parse(saved.content)).toMatchObject([
			{ id: 1, startTime: 1, text: "Use A --> B" },
		]);
	});
});
