import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCaptionCues,
	buildWebVtt,
	CAPTION_LINE_CHARACTERS,
	CAPTION_MAX_CUE_MS,
	CAPTION_READING_MS_PER_CHARACTER,
	type CaptionWord,
	escapeVttText,
	formatVttTimestamp,
} from "@/lib/developer-transcript-vtt";

const GOLDEN = join(__dirname, "../fixtures/developer-captions-golden.vtt");

const say = (
	startSeconds: number,
	secondsPerWord: number,
	text: string,
): CaptionWord[] =>
	text.split(" ").map((word, index) => {
		const start = startSeconds + index * secondsPerWord;
		return {
			text: word,
			start: Math.round(start * 1000) / 1000,
			end: Math.round((start + secondsPerWord * 0.8) * 1000) / 1000,
		};
	});

const FIXED_WORDS: CaptionWord[] = [
	...say(0.24, 0.32, "Welcome back."),
	...say(
		1.6,
		0.4,
		"Today we are walking through the quarterly numbers for the whole company, region by region, and then we will look at what changed in the product since the last time we all met in this room.",
	),
	...say(18.4, 0.36, "We shipped 1,250 units in Q3 2026 for $3.5 million."),
	...say(
		23.2,
		0.12,
		"And yes I know that is a lot to take in all at once so bear with me please.",
	),
	...say(26.4, 0.4, "Let me think"),
	...say(31.2, 0.4, "about that for a second."),
	...say(
		34.4,
		0.4,
		"Is 5 < 7 && 9 > 2? Tom & Jerry said <b>yes</b> --> maybe.",
	),
	...say(41.6, 0.4, "Okay."),
	{ text: "Line\nbreak  inside", start: 43.2, end: 44 },
	{ text: "", start: 44.2, end: 44.4 },
	{ text: "end.", start: 44.4, end: 44.8 },
];

type ParsedCue = { start: number; end: number; lines: string[] };

const parseTimestamp = (value: string) => {
	const match = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
	if (!match) throw new Error(`Bad timestamp ${value}`);
	const [, hours, minutes, seconds, millis] = match;
	return (
		Number(hours) * 3_600_000 +
		Number(minutes) * 60_000 +
		Number(seconds) * 1000 +
		Number(millis)
	);
};

function parseVtt(text: string): ParsedCue[] {
	const [header, ...blocks] = text.trimEnd().split("\n\n");
	if (header !== "WEBVTT") throw new Error("Missing WEBVTT header");
	return blocks.map((block) => {
		const [timing, ...lines] = block.split("\n");
		const [start, arrow, end, ...rest] = (timing ?? "").split(" ");
		if (arrow !== "-->" || rest.length > 0 || !start || !end) {
			throw new Error(`Bad timing line ${timing}`);
		}
		if (lines.length === 0 || lines.some((line) => line.trim() === "")) {
			throw new Error("Cue has an empty line");
		}
		return { start: parseTimestamp(start), end: parseTimestamp(end), lines };
	});
}

describe("WebVTT captions from word timings", () => {
	it("matches the golden file for fixed word timings", () => {
		expect(buildWebVtt(FIXED_WORDS, 46)).toBe(readFileSync(GOLDEN, "utf8"));
	});

	it("parses, and its cues never overlap or go backwards", () => {
		const cues = parseVtt(buildWebVtt(FIXED_WORDS, 46) ?? "");
		expect(cues.length).toBeGreaterThan(8);
		let previousEnd = 0;
		for (const cue of cues) {
			expect(cue.start).toBeGreaterThanOrEqual(previousEnd);
			expect(cue.end).toBeGreaterThan(cue.start);
			previousEnd = cue.end;
		}
	});

	it("keeps every cue to two lines of about 42 characters and 7 seconds", () => {
		const cues = buildCaptionCues(FIXED_WORDS, 46);
		for (const cue of cues) {
			expect(cue.lines.length).toBeLessThanOrEqual(2);
			for (const line of cue.lines) {
				expect(line.length).toBeLessThanOrEqual(CAPTION_LINE_CHARACTERS);
			}
			expect(cue.end - cue.start).toBeLessThanOrEqual(CAPTION_MAX_CUE_MS);
		}
	});

	it("keeps every word, in order", () => {
		const cues = buildCaptionCues(FIXED_WORDS, 46);
		expect(cues.flatMap((cue) => cue.lines).join(" ")).toBe(
			FIXED_WORDS.map((word) => word.text.replace(/\s+/g, " ").trim())
				.filter(Boolean)
				.join(" "),
		);
	});

	it("ends a cue at the end of a sentence", () => {
		const cues = buildCaptionCues(FIXED_WORDS, 46);
		expect(cues[0]?.lines).toEqual(["Welcome back."]);
		expect(cues.at(-1)?.lines.join(" ")).toBe("Line break inside end.");
	});

	it("starts a new cue after a pause, even inside a sentence", () => {
		const cues = buildCaptionCues(FIXED_WORDS, 46);
		const before = cues.find((cue) => cue.lines.join(" ") === "Let me think");
		const after = cues.find(
			(cue) => cue.lines.join(" ") === "about that for a second.",
		);
		expect(before).toBeDefined();
		expect(after?.start).toBe(31_200);
		expect(before?.end).toBeLessThanOrEqual(28_520);
	});

	it("escapes the characters WebVTT reserves and never emits an arrow in text", () => {
		const text = buildWebVtt(FIXED_WORDS, 46) ?? "";
		expect(text).toContain("Is 5 &lt; 7 &amp;&amp; 9 &gt; 2?");
		expect(text).toContain("&lt;b&gt;yes&lt;/b&gt; --&gt; maybe.");
		expect(text).toContain("Tom &amp; Jerry");
		const cueText = parseVtt(text).flatMap((cue) => cue.lines);
		expect(cueText.some((line) => line.includes("-->"))).toBe(false);
		expect(cueText.some((line) => /[<>]/.test(line))).toBe(false);
		expect(escapeVttText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});

	it("holds quick speech on screen long enough to read, up to the next cue", () => {
		const cues = buildCaptionCues(FIXED_WORDS, 46);
		const quick = cues.filter(
			(cue) => cue.start >= 23_200 && cue.start < 26_400,
		);
		const text = quick.flatMap((cue) => cue.lines).join(" ");
		expect(text).toBe(
			"And yes I know that is a lot to take in all at once so bear with me please.",
		);
		expect(quick).toHaveLength(1);
		const spokenEnd = 25_456;
		expect(quick[0]?.end).toBeGreaterThan(spokenEnd);
		expect(quick[0]?.end).toBe(26_400);
		expect((quick[0]?.end ?? 0) - (quick[0]?.start ?? 0)).toBeLessThan(
			text.length * CAPTION_READING_MS_PER_CHARACTER,
		);
	});

	it("does not hold normal speech past its last word", () => {
		const cues = buildCaptionCues(FIXED_WORDS, 46);
		const shipped = cues.find((cue) => cue.lines[0]?.startsWith("We shipped"));
		expect(shipped?.end).toBe(21_928);
	});

	it("writes one cue for a single word and holds it for a second", () => {
		expect(buildWebVtt([{ text: "Hello", start: 2, end: 2.24 }], 10)).toBe(
			"WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nHello\n",
		);
	});

	it("does not hold a single word past the end of the media", () => {
		expect(buildWebVtt([{ text: "Bye", start: 9.6, end: 9.84 }], 10)).toBe(
			"WEBVTT\n\n00:00:09.600 --> 00:00:10.000\nBye\n",
		);
	});

	it("writes nothing when there are no words", () => {
		expect(buildWebVtt([], 30)).toBeNull();
		expect(buildWebVtt(null, 30)).toBeNull();
		expect(buildWebVtt([{ text: "  ", start: 1, end: 2 }], 30)).toBeNull();
	});

	it("never lets a cue start before the one before it ended when timings overlap or go backwards", () => {
		const cues = buildCaptionCues([
			{ text: "First.", start: 5, end: 9 },
			{ text: "Second.", start: 4, end: 6 },
			{ text: "Third.", start: 6, end: 6.5 },
			{ text: "Fourth.", start: Number.NaN, end: -3 },
		]);
		let previousEnd = 0;
		for (const cue of cues) {
			expect(cue.start).toBeGreaterThanOrEqual(previousEnd);
			expect(cue.end).toBeGreaterThan(cue.start);
			previousEnd = cue.end;
		}
		expect(cues).toHaveLength(4);
	});

	it("caps one very long word at 7 seconds and keeps it on its own line", () => {
		const long = "a".repeat(60);
		const cues = buildCaptionCues([{ text: long, start: 0, end: 30 }]);
		expect(cues).toEqual([{ start: 0, end: 7_000, lines: [long] }]);
	});

	it("formats hours past the first", () => {
		expect(formatVttTimestamp(0)).toBe("00:00:00.000");
		expect(formatVttTimestamp(3_723_045)).toBe("01:02:03.045");
		expect(formatVttTimestamp(14_399_999)).toBe("03:59:59.999");
	});
});
