import { describe, expect, it } from "vitest";
import { formatTranscriptAsVTT } from "@/app/s/[videoId]/_components/utils/transcript-utils";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
	groupEditTranscriptWords,
	parseEditTranscript,
	remapEditTranscriptThroughSpec,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { formatTranscriptAsParagraphs } from "@/lib/transcript-text";
import {
	formatVttCueText,
	parseVTT,
	parseVttCueText,
	updateVttEntryText,
} from "@/lib/transcript-vtt";

const transcript = createEditTranscript(
	{
		words: [
			{ text: "Hello", start: 100, end: 300, speaker: "A" },
			{ text: "there", start: 300, end: 600, speaker: "A" },
			{ text: "Hi", start: 650, end: 800, speaker: "B" },
			{ text: "again", start: 850, end: 1000, speaker: "A" },
			{ text: "unknown", start: 1100, end: 1300, speaker: null },
		],
	},
	2000,
);

describe("speaker diarization", () => {
	it("splits captions on every speaker transition without needing punctuation or silence", () => {
		const cues = parseVTT(editTranscriptWordsToCaptionVtt(transcript.words));
		expect(
			cues.map(({ text, speaker, startTime, endTime }) => ({
				text,
				speaker,
				startTime,
				endTime,
			})),
		).toEqual([
			{ text: "Hello there", speaker: "A", startTime: 0.1, endTime: 0.6 },
			{ text: "Hi", speaker: "B", startTime: 0.65, endTime: 0.8 },
			{ text: "again", speaker: "A", startTime: 0.85, endTime: 1 },
			{ text: "unknown", speaker: null, startTime: 1.1, endTime: 1.3 },
		]);
	});

	it("preserves labels through storage, video cuts, caption regeneration, and download", () => {
		const stored = parseEditTranscript(serializeEditTranscript(transcript));
		expect(stored).not.toBeNull();
		if (!stored) throw new Error("Missing transcript");
		const edited = remapEditTranscriptThroughSpec(stored, {
			version: 1,
			sourceDuration: 2,
			keepRanges: [{ start: 0.6, end: 2 }],
		});
		const cues = parseVTT(editTranscriptWordsToCaptionVtt(edited.words));
		expect(cues[0]).toMatchObject({
			text: "Hi",
			speaker: "B",
			startTime: 0.05,
		});
		expect(parseVTT(formatTranscriptAsVTT(cues))).toEqual(cues);
	});

	it("shows separate editor groups and text paragraphs for speakers and unknown speech", () => {
		expect(
			groupEditTranscriptWords(transcript.words).map(
				({ startIndex, endIndex }) => [startIndex, endIndex],
			),
		).toEqual([
			[0, 1],
			[2, 2],
			[3, 3],
			[4, 4],
		]);
		expect(
			formatTranscriptAsParagraphs(
				parseVTT(editTranscriptWordsToCaptionVtt(transcript.words)),
			),
		).toBe(
			"Speaker A: Hello there\n\nSpeaker B: Hi\n\nSpeaker A: again\n\nunknown",
		);
	});

	it("preserves the voice when editing spoken text and escapes markup", () => {
		const vtt = editTranscriptWordsToCaptionVtt(transcript.words);
		const updated = updateVttEntryText(vtt, 2, "Yes <script> & no");
		expect(updated.updated).toBe(true);
		expect(updated.content).toContain(
			"<v Speaker B>Yes &lt;script&gt; &amp; no</v>",
		);
		expect(parseVTT(updated.content)[1]).toMatchObject({
			speaker: "B",
			text: "Yes <script> & no",
			startTime: 0.65,
			endTime: 0.8,
		});
	});

	it("handles multiline voice cues, legacy plain cues, and escaped labels", () => {
		const cues = parseVTT(
			"WEBVTT\r\n\r\n1\r\n00:00:00.125 --> 00:00:01.500\r\n<v Speaker A>Hello\r\nthere</v>\r\n\r\n2\r\n00:00:01.500 --> 00:00:02.000\r\nLegacy text\r\n",
		);
		expect(cues[0]).toMatchObject({
			text: "Hello there",
			speaker: "A",
			startTime: 0.125,
			endTime: 1.5,
		});
		expect(cues[1]).toMatchObject({ text: "Legacy text", speaker: null });
		expect(parseVttCueText(formatVttCueText("2 < 3 & 4 > 1", "A & B"))).toEqual(
			{ text: "2 < 3 & 4 > 1", speaker: "A & B" },
		);
	});

	it("preserves literal angle brackets in legacy cues through copying and exports", () => {
		const cues = parseVTT(
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n2 < 3 and 4 > 1\n\n2\n00:00:02.000 --> 00:00:03.000\nThe answer is < 5\n",
		);
		expect(cues.map(({ text }) => text)).toEqual([
			"2 < 3 and 4 > 1",
			"The answer is < 5",
		]);
		expect(formatTranscriptAsParagraphs(cues)).toBe(
			"2 < 3 and 4 > 1 The answer is < 5",
		);
		expect(parseVTT(formatTranscriptAsVTT(cues))).toEqual(cues);
	});

	it("strips recognized WebVTT markup and timestamps without stripping literal text", () => {
		expect(
			parseVttCueText(
				"<v.class Speaker A><b>2 < 3</b> <c.green>and</c> <i>4 > 1</i> <00:00:01.000><lang en><u>five</u></lang> <ruby>six<rt>6</rt></ruby></v>",
			),
		).toEqual({ text: "2 < 3 and 4 > 1 five six6", speaker: "A" });
		expect(parseVttCueText("Literal <value> &lt;b&gt; and <b")).toEqual({
			text: "Literal <value> <b> and <b",
			speaker: null,
		});
	});
});

it("keeps speaker metadata and literal text through the agent transcript API", async () => {
	const { parseAgentVtt, renderAgentVtt } = await import("@/lib/agent-api");
	const cues = [
		{ startMs: 125, endMs: 500, text: "R&D < planning", speaker: "B" },
	];
	expect(parseAgentVtt(renderAgentVtt(cues))).toEqual(cues);
	expect(
		parseAgentVtt(
			"WEBVTT\n\n1\n00:00:00.125 --> 00:00:00.500\n<v Speaker B>R&D < planning</v>\n",
		),
	).toEqual(cues);
});

it("keeps escaped angle-bracket speech through the agent transcript API", async () => {
	const { parseAgentVtt, renderAgentVtt } = await import("@/lib/agent-api");
	const cues = [
		{ startMs: 0, endMs: 1_000, text: "Type <value> then <b", speaker: "A" },
	];
	expect(parseAgentVtt(renderAgentVtt(cues))).toEqual(cues);
	expect(
		parseAgentVtt(
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n<v Speaker A><c.green>Type &lt;value&gt;</c> <00:00:00.500>then &lt;b</v>\n",
		),
	).toEqual(cues);
	expect(
		parseAgentVtt(
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n<v Speaker A>Type &lt;value&gt; then <b</v>\n",
		),
	).toEqual(cues);
});
