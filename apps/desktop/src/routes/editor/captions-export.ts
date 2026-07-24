import type {
	CaptionSegment,
	SegmentRecordings,
	TimelineSegment,
} from "~/utils/tauri";
import {
	getCaptionTextFromWords,
	mapCaptionsToEditedTimeline,
} from "./captions";
import type { ClipTransition } from "./clip-transitions";

export type CaptionExportFormat = "srt" | "vtt";

export interface CaptionExportCue {
	startMs: number;
	endMs: number;
	text: string;
}

const DOUBLE_QUOTE = String.fromCharCode(34);
const INVALID_FILE_NAME_CHARS = new Set([
	"<",
	">",
	":",
	DOUBLE_QUOTE,
	"/",
	"\\",
	"|",
	"?",
	"*",
]);

function millisecondsFromSeconds(seconds: number) {
	return Math.max(0, Math.round(seconds * 1000));
}

function formatTimestamp(ms: number, separator: "," | ".") {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	const milliseconds = ms % 1000;

	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}${separator}${milliseconds.toString().padStart(3, "0")}`;
}

function textFromCaptionSegment(segment: CaptionSegment) {
	const words = segment.words ?? [];
	if (words.length > 0) return getCaptionTextFromWords(words);
	return segment.text;
}

function cueRangeFromCaptionSegment(segment: CaptionSegment) {
	const words = segment.words ?? [];
	const firstWord = words[0];
	const lastWord = words[words.length - 1];
	return {
		start: firstWord?.start ?? segment.start,
		end: lastWord?.end ?? segment.end,
	};
}

function normalizeCueText(text: string) {
	return text
		.replace(/\r\n?/g, "\n")
		.split("")
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code === 10 || (code >= 32 && code !== 127);
		})
		.join("")
		.split("\n")
		.map((line) => line.trim().replace(/\s+/g, " "))
		.filter((line) => line.length > 0)
		.join("\n")
		.trim();
}

function normalizeVttCueText(text: string) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function cueFromCaptionSegment(
	segment: CaptionSegment,
): CaptionExportCue | null {
	const text = normalizeCueText(textFromCaptionSegment(segment));
	const { start, end } = cueRangeFromCaptionSegment(segment);

	if (
		text.length === 0 ||
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		end <= start
	) {
		return null;
	}

	const startMs = millisecondsFromSeconds(start);
	const roundedEndMs = millisecondsFromSeconds(end);
	const endMs = roundedEndMs <= startMs ? startMs + 1 : roundedEndMs;

	return { startMs, endMs, text };
}

export function createCaptionExportCues(
	segments: CaptionSegment[],
	timelineSegments: TimelineSegment[],
	recordingSegments: SegmentRecordings[],
	transitions: ClipTransition[] = [],
): CaptionExportCue[] {
	return mapCaptionsToEditedTimeline(
		segments,
		timelineSegments,
		recordingSegments,
		transitions,
	)
		.map(cueFromCaptionSegment)
		.filter((cue): cue is CaptionExportCue => cue !== null)
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function formatCaptionCuesAsSrt(cues: CaptionExportCue[]) {
	if (cues.length === 0) return "";

	return `${cues
		.map(
			(cue, index) =>
				`${index + 1}\n${formatTimestamp(cue.startMs, ",")} --> ${formatTimestamp(cue.endMs, ",")}\n${cue.text}`,
		)
		.join("\n\n")}\n`;
}

export function formatCaptionCuesAsVtt(cues: CaptionExportCue[]) {
	if (cues.length === 0) return "WEBVTT\n";

	return `WEBVTT\n\n${cues
		.map(
			(cue, index) =>
				`${index + 1}\n${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n${normalizeVttCueText(cue.text)}`,
		)
		.join("\n\n")}\n`;
}

export function formatCaptionCues(
	cues: CaptionExportCue[],
	format: CaptionExportFormat,
) {
	return format === "srt"
		? formatCaptionCuesAsSrt(cues)
		: formatCaptionCuesAsVtt(cues);
}

export function captionExportDefaultPath(
	name: string,
	format: CaptionExportFormat,
) {
	const cleanedName = name
		.trim()
		.split("")
		.map((char) => {
			const code = char.charCodeAt(0);
			return INVALID_FILE_NAME_CHARS.has(char) || code < 32 ? "-" : char;
		})
		.join("")
		.replace(/\s+/g, " ")
		.replace(/\.+$/g, "")
		.slice(0, 120)
		.trim();

	return `${cleanedName || "captions"}.${format}`;
}

if (import.meta.vitest) {
	const { describe, expect, it } = import.meta.vitest;

	describe("caption exports", () => {
		const recordings = [{ display: { duration: 8 } } as SegmentRecordings];

		it("formats projected edited timeline cues as SRT", () => {
			const cues = createCaptionExportCues(
				[
					{
						id: "caption",
						start: 1,
						end: 5,
						text: "hello world",
						words: [
							{ text: "hello", start: 1.1114, end: 1.4446 },
							{ text: "world", start: 4.2, end: 4.6 },
						],
					},
				],
				[
					{ start: 1, end: 2, timescale: 1, recordingSegment: 0 },
					{ start: 4, end: 6, timescale: 1, recordingSegment: 0 },
				],
				recordings,
			);

			expect(formatCaptionCuesAsSrt(cues)).toBe(
				"1\n00:00:00,111 --> 00:00:00,445\nhello\n\n2\n00:00:01,200 --> 00:00:01,600\nworld\n",
			);
		});

		it("formats VTT with escaped cue text", () => {
			expect(
				formatCaptionCuesAsVtt([
					{
						startMs: 0,
						endMs: 1250,
						text: "Cap <Rend> & fast --> captions",
					},
				]),
			).toBe(
				"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.250\nCap &lt;Rend&gt; &amp; fast --&gt; captions\n",
			);
		});

		it("cleans invalid filenames and falls back when empty", () => {
			expect(
				captionExportDefaultPath(["bad/name:", DOUBLE_QUOTE].join(""), "srt"),
			).toBe("bad-name--.srt");
			expect(captionExportDefaultPath("...", "vtt")).toBe("captions.vtt");
		});

		it("skips empty and invalid cues", () => {
			const cues = createCaptionExportCues(
				[
					{
						id: "empty",
						start: 0,
						end: 1,
						text: " ",
						words: [],
					},
					{
						id: "backwards",
						start: 2,
						end: 1,
						text: "backwards",
						words: [],
					},
					{
						id: "valid",
						start: 1,
						end: 1.0001,
						text: "valid",
						words: [],
					},
				],
				[{ start: 0, end: 8, timescale: 1, recordingSegment: 0 }],
				recordings,
			);

			expect(cues).toEqual([{ startMs: 1000, endMs: 1001, text: "valid" }]);
		});
	});
}
