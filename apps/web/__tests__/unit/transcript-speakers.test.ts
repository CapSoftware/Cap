import { describe, expect, it } from "vitest";
import { parseTranscriptVTT } from "@/app/s/[videoId]/_components/utils/parse-transcript-vtt";
import {
	createEditTranscript,
	groupEditTranscriptWords,
} from "@/lib/edit-transcript";
import { formatToWebVTT } from "@/lib/transcribe-utils";
import {
	parseTranscriptSpeakerNames,
	transcriptSpeakerLabel,
} from "@/lib/transcript-speakers";
import { updateVttEntryText } from "@/lib/transcript-vtt";

const vtt =
	"WEBVTT\n\n1\n00:00:01.125 --> 00:00:03.000\n<v A>Hello &amp; welcome</v>\n\n2\n00:00:02.250 --> 00:00:04.000\n<v B>Overlapping</v>\n\n3\n00:00:08.000 --> 00:00:09.000\nLegacy\n";
describe("speaker transcript compatibility", () => {
	it("never attributes an unknown editor turn to its labeled neighbor", () => {
		const transcript = createEditTranscript(
			{
				words: [
					{ text: "Known", start: 0, end: 300, speaker: "A" },
					{ text: "Unknown", start: 400, end: 700, speaker: null },
					{ text: "Known again", start: 800, end: 1000, speaker: "B" },
				],
			},
			1000,
		);
		expect(
			groupEditTranscriptWords(transcript.words).map(
				({ startIndex, endIndex }) => [startIndex, endIndex],
			),
		).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
		]);
	});
	it("preserves overlap ends and escapes provider text without treating text as a speaker", () => {
		const content = formatToWebVTT({
			words: [
				{ text: "<v B>not identity</v>", start: 0, end: 2000, speaker: "A" },
				{ text: "& welcome", start: 1000, end: 1500, speaker: "A" },
				{ text: "Unknown", start: 3000, end: 3500, speaker: null },
				{ text: "After silence", start: 5000, end: 5500, speaker: "B" },
			],
		});
		const turns = parseTranscriptVTT(content);
		expect(
			turns.map(({ speaker, startTime, endTime }) => [
				speaker,
				startTime,
				endTime,
			]),
		).toEqual([
			["A", 0, 2],
			[undefined, 3, 3.5],
			["B", 5, 5.5],
		]);
		expect(turns[0]?.text).toBe("<v B>not identity</v> & welcome");
	});
	it("preserves overlapping timing and unknown legacy turns", () => {
		const turns = parseTranscriptVTT(vtt);
		expect(
			turns.map((turn) => [turn.speaker, turn.startTime, turn.endTime]),
		).toEqual([
			["A", 1.125, 3],
			["B", 2.25, 4],
			[undefined, 8, 9],
		]);
		expect(turns[0]?.text).toBe("Hello & welcome");
		expect(transcriptSpeakerLabel(undefined, {})).toBe("Unknown speaker");
		expect(parseTranscriptVTT("WEBVTT\n\n")).toEqual([]);
	});
	it("retains speaker identity and timestamps through existing text edits", () => {
		const changed = updateVttEntryText(vtt, 1, "Edited <not markup> & text");
		expect(changed.updated).toBe(true);
		expect(parseTranscriptVTT(changed.content)[0]).toEqual({
			...parseTranscriptVTT(vtt)[0],
			text: "Edited <not markup> & text",
		});
		expect(changed.content).toContain(
			"<v A>Edited &lt;not markup&gt; &amp; text</v>",
		);
	});
	it("ignores malformed and dangerous metadata without changing safe names", () => {
		expect(
			parseTranscriptSpeakerNames(
				JSON.parse(
					'{"__proto__":"bad","constructor":"bad","A":"Alice","B":42,"C":"<script>"}',
				),
			),
		).toEqual({ A: "Alice" });
		for (const invalid of [null, [], "Alice", 4])
			expect(parseTranscriptSpeakerNames(invalid)).toEqual({});
		expect(transcriptSpeakerLabel("toString", {})).toBe("Speaker toString");
	});
});
