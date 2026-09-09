import { describe, expect, it } from "vitest";
import { formatToWebVTT } from "@/lib/transcribe-utils";
import { groupTranscriptSentences } from "@/lib/transcript-sentences";
import { parseVTT, type TranscriptEntry } from "@/lib/transcript-vtt";

function entries(texts: string[], speaker: string | null = "A") {
	return texts.map(
		(text, index): TranscriptEntry => ({
			id: index + 1,
			text,
			startTime: index * 2 + 0.125,
			endTime: index * 2 + 1,
			timestamp: `00:${String(index * 2).padStart(2, "0")}`,
			speaker,
		}),
	);
}

describe("groupTranscriptSentences", () => {
	it("joins comma, pause and eight-word caption breaks into a full sentence", () => {
		const words =
			"Immediate release, extended release, это всё одна фраза которую нужно читать целиком."
				.split(" ")
				.map((text, index) => ({
					text,
					start: index * 1_000,
					end: index * 1_000 + 300,
					speaker: "A",
				}));
		const captions = parseVTT(formatToWebVTT({ words }));
		expect(captions.length).toBeGreaterThan(8);
		expect(groupTranscriptSentences(captions)).toEqual([
			{
				...captions[0],
				text: words.map((word) => word.text).join(" "),
				endTime: 11.3,
			},
		]);
	});

	it("uses sentence punctuation, including closing quotes and CJK punctuation", () => {
		const result = groupTranscriptSentences(
			entries([
				"И как бы,",
				"сейчас,",
				"где она здесь?",
				"Он сказал:",
				"«Вот это.»",
				"真的。",
				"Next!",
			]),
		);
		expect(result.map((entry) => entry.text)).toEqual([
			"И как бы, сейчас, где она здесь?",
			"Он сказал: «Вот это.»",
			"真的。",
			"Next!",
		]);
	});

	it("keeps abbreviations and hesitation ellipses with the following phrase", () => {
		expect(
			groupTranscriptSentences(
				entries(["Dr.", "Smith said,", "I want...", "to continue."]),
			).map((entry) => entry.text),
		).toEqual(["Dr. Smith said, I want... to continue."]);
	});

	it("never combines different or unknown speakers", () => {
		const source = entries(["First,", "second,", "unknown,", "fourth."]);
		if (source[1]) source[1].speaker = "B";
		if (source[2]) source[2].speaker = null;
		expect(groupTranscriptSentences(source)).toEqual(source);
	});

	it("keeps the first cue identity and exact outer timestamps without mutating cues", () => {
		const source = entries(["One,", "two."]);
		const original = structuredClone(source);
		expect(groupTranscriptSentences(source)[0]).toEqual({
			...source[0],
			text: "One, two.",
			endTime: 3,
		});
		expect(source).toEqual(original);
	});

	it("breaks at long silence and overlapping cues", () => {
		const source = entries(["Before", "after"]);
		if (source[1]) source[1].startTime = 6;
		expect(groupTranscriptSentences(source)).toHaveLength(2);
		if (source[1]) source[1].startTime = 0.5;
		expect(groupTranscriptSentences(source)).toHaveLength(2);
	});

	it("bounds unpunctuated speech and retains every fragment", () => {
		const source = entries(
			Array.from({ length: 100 }, () => "a long unpunctuated fragment"),
		);
		const grouped = groupTranscriptSentences(source);
		expect(grouped.length).toBeGreaterThan(1);
		expect(
			grouped.every(
				(entry) =>
					entry.text.length <= 800 && entry.endTime - entry.startTime <= 45,
			),
		).toBe(true);
		expect(grouped.map((entry) => entry.text).join(" ")).toBe(
			source.map((entry) => entry.text).join(" "),
		);
	});

	it("handles empty input and unfinished live sentences", () => {
		expect(groupTranscriptSentences([])).toEqual([]);
		expect(groupTranscriptSentences(entries([" "]))).toEqual([]);
		expect(
			groupTranscriptSentences(entries(["still", "speaking"]))[0]?.text,
		).toBe("still speaking");
	});
});
