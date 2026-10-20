import { describe, expect, it } from "vitest";
import { defaultCaptionSettings } from "~/store/captions";
import type {
	SegmentRecordings,
	TimelineSegment,
	TranscriptCut,
} from "~/utils/tauri";
import {
	applyCaptionResultToProject,
	deriveCaptionTrackSegments,
} from "./captions";
import { clipTimelineDuration } from "./clip-transitions";
import type { EditorProjectConfiguration } from "./context";
import {
	isFillerWord,
	readsAsEnglish,
	spokenWordEnd,
} from "./filler-detection";
import { defaultMaskSegment } from "./masks";
import { defaultTextSegment } from "./text";
import {
	commitTranscriptCutEdit,
	cutClaim,
	cutPaddingLimits,
	cutPaddingRoom,
	intersectSourceRanges,
	mergeSourceRanges,
	planAutoClean,
	planPauseCut,
	planWordCuts,
	type RecordingAudio,
	recordingAudio,
	type SourceRange,
	subtractSourceRanges,
	type TranscriptItem,
	transcriptPlanContext,
} from "./transcript-cuts";
import { deleteTranscriptWords } from "./transcript-edits";

type Project = Pick<EditorProjectConfiguration, "captions" | "timeline">;
type Timeline = NonNullable<Project["timeline"]>;

const recordings = (...durations: number[]) =>
	durations.map((duration) => ({ display: { duration } }) as SegmentRecordings);

const clip = (
	start: number,
	end: number,
	extra: Partial<TimelineSegment> = {},
): TimelineSegment => ({
	start,
	end,
	timescale: 1,
	recordingSegment: 0,
	...extra,
});

function project(
	words: Array<[string, number, number]>,
	segments: TimelineSegment[],
	tracks: Partial<Timeline> = {},
): Project {
	return {
		captions: {
			settings: { ...defaultCaptionSettings },
			sourceTimed: true,
			segments: [
				{
					id: "caption",
					start: words[0][1],
					end: words[words.length - 1][2],
					text: words.map(([text]) => text).join(" "),
					words: words.map(([text, start, end]) => ({ text, start, end })),
				},
			],
		},
		timeline: {
			segments,
			transitions: [],
			zoomSegments: [],
			captionSegments: [],
			keyboardSegments: [],
			sceneSegments: [],
			maskSegments: [],
			textSegments: [],
			styleSegments: [],
			imageSegments: [],
			camera3dSegments: [],
			...tracks,
		},
	};
}

let nextId = 0;
const createId = () => `test-cut-${nextId++}`;

function context(p: Project, recs: SegmentRecordings[]) {
	return { ...transcriptPlanContext(p, recs), createId };
}

function token(items: readonly TranscriptItem[], text: string) {
	const item = items.find(
		(candidate) =>
			(candidate.type === "word" && candidate.word.text === text) ||
			(candidate.type === "cut-word" && candidate.cut.text === text),
	);
	if (!item || (item.type !== "word" && item.type !== "cut-word"))
		throw new Error(`No transcript token for ${text}`);
	return item.token;
}

function cut(p: Project, recs: SegmentRecordings[], ...texts: string[]) {
	const ctx = context(p, recs);
	const edit = planWordCuts(
		ctx,
		texts.map((text) => token(ctx.items, text)),
	);
	if (!edit) throw new Error("Nothing to cut");
	return commitTranscriptCutEdit(p, edit, recs);
}

function cutRecord(p: Project, text: string): TranscriptCut {
	const record = p.captions?.transcriptCuts?.find((cut) => cut.text === text);
	if (!record) throw new Error(`No cut for ${text}`);
	return record;
}

function liveWords(p: Project) {
	return (p.captions?.segments ?? []).flatMap((segment) =>
		(segment.words ?? []).map((word) => word.text),
	);
}

function clips(p: Project) {
	return (p.timeline?.segments ?? []).map((segment) => [
		Number(segment.start.toFixed(6)),
		Number(segment.end.toFixed(6)),
	]);
}

const helloWorld: Array<[string, number, number]> = [
	["hello", 1.0, 1.4],
	["um", 1.6, 1.9],
	["world", 2.0, 2.5],
	["again", 4.0, 4.4],
];

describe("source range arithmetic", () => {
	it("merges, subtracts and intersects ranges", () => {
		expect(
			mergeSourceRanges([
				{ start: 3, end: 4 },
				{ start: 1, end: 2 },
				{ start: 2, end: 2.5 },
				{ start: 5, end: 5.00001 },
			]),
		).toEqual([
			{ start: 1, end: 2.5 },
			{ start: 3, end: 4 },
		]);
		expect(
			subtractSourceRanges(
				[{ start: 0, end: 10 }],
				[
					{ start: 2, end: 3 },
					{ start: 5, end: 6 },
				],
			),
		).toEqual([
			{ start: 0, end: 2 },
			{ start: 3, end: 5 },
			{ start: 6, end: 10 },
		]);
		expect(
			intersectSourceRanges(
				[
					{ start: 0, end: 2 },
					{ start: 4, end: 6 },
				],
				[{ start: 1, end: 5 }],
			),
		).toEqual([
			{ start: 1, end: 2 },
			{ start: 4, end: 5 },
		]);
	});
});

describe("transcript word cuts", () => {
	it("cuts a word out of the video and restores it exactly", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);

		expect(cut(p, recs, "um")).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.6],
			[1.9, 10],
		]);
		expect(liveWords(p)).toEqual(["hello", "world", "again"]);
		expect(p.captions?.segments[0].text).toBe("hello world again");
		expect(p.captions?.transcriptCuts).toHaveLength(1);
		const track = deriveCaptionTrackSegments(
			p.captions?.segments ?? [],
			p.timeline?.segments ?? [],
			recs,
		);
		expect(
			track.flatMap((segment) => segment.words?.map((w) => w.text)),
		).toEqual(["hello", "world", "again"]);

		expect(
			commitTranscriptCutEdit(p, { restore: [cutRecord(p, "um").id] }, recs),
		).toBe("applied");
		expect(clips(p)).toEqual([[0, 10]]);
		expect(liveWords(p)).toEqual(["hello", "um", "world", "again"]);
		expect(p.captions?.segments[0].text).toBe("hello um world again");
		expect(p.captions?.transcriptCuts).toEqual([]);
		expect(p.captions?.transcriptRemoved).toEqual([]);
	});

	it("moves overlay tracks out with the cut and back on restore", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)], {
			zoomSegments: [
				{ start: 0.5, end: 0.9, amount: 2, mode: "auto" },
				{ start: 1.0, end: 3.0, amount: 2, mode: "auto" },
				{ start: 5, end: 6, amount: 2, mode: "auto" },
			],
			keyboardSegments: [
				{
					id: "keys",
					start: 5,
					end: 6,
					displayText: "ab",
					keys: [
						{ key: "a", timeOffset: 0 },
						{ key: "b", timeOffset: 500 },
					],
				},
			],
			maskSegments: [
				{
					...defaultMaskSegment(1.0, 4.0),
					keyframes: {
						position: [
							{ time: 0.2, x: 0.1, y: 0.1 },
							{ time: 2.5, x: 0.9, y: 0.9 },
						],
						size: [],
						intensity: [],
					},
				},
			],
		});
		const before = structuredClone(p.timeline);

		cut(p, recs, "um");
		expect(
			p.timeline?.zoomSegments.map(({ start, end }) => [start, end]),
		).toEqual([
			[0.5, 0.9],
			[1.0, expect.closeTo(2.7)],
			[expect.closeTo(4.7), expect.closeTo(5.7)],
		]);
		expect(p.timeline?.keyboardSegments?.[0].start).toBeCloseTo(4.7);

		commitTranscriptCutEdit(p, { restore: [cutRecord(p, "um").id] }, recs);
		expect(
			p.timeline?.zoomSegments.map(({ start, end }) => [start, end]),
		).toEqual(
			before?.zoomSegments.map(({ start, end }) => [
				expect.closeTo(start),
				expect.closeTo(end),
			]),
		);
		expect(p.timeline?.keyboardSegments?.[0]).toMatchObject({
			start: expect.closeTo(5),
			end: expect.closeTo(6),
			keys: [
				{ key: "a", timeOffset: expect.closeTo(0) },
				{ key: "b", timeOffset: expect.closeTo(500) },
			],
		});
		expect(p.timeline?.maskSegments[0]).toMatchObject({
			start: 1.0,
			end: expect.closeTo(4.0),
			keyframes: {
				position: [
					{ time: expect.closeTo(0.2) },
					{ time: expect.closeTo(2.5) },
				],
			},
		});
	});

	it("round-trips overlays around a fullscreen text hold", () => {
		const recs = recordings(10);
		const hold = {
			...defaultTextSegment(5, 7),
			layout: "fullscreen" as const,
		};
		const p = project(
			[
				["um", 1.6, 1.9],
				["late", 6.0, 6.3],
			],
			[clip(0, 10)],
			{
				textSegments: [hold],
				zoomSegments: [{ start: 8.5, end: 9, amount: 2, mode: "auto" }],
			},
		);

		cut(p, recs, "um");
		cut(p, recs, "late");
		expect(clips(p)).toEqual([
			[0, 1.6],
			[1.9, 6.0],
			[6.3, 10],
		]);
		expect(p.timeline?.textSegments[0].start).toBeCloseTo(4.7);
		expect(p.timeline?.textSegments[0].end).toBeCloseTo(6.7);
		expect(p.timeline?.zoomSegments[0].start).toBeCloseTo(7.9);
		expect(p.timeline?.zoomSegments[0].end).toBeCloseTo(8.4);

		commitTranscriptCutEdit(
			p,
			{ restore: p.captions?.transcriptCuts?.map((cut) => cut.id) },
			recs,
		);
		expect(clips(p)).toEqual([[0, 10]]);
		expect(p.timeline?.textSegments[0]).toMatchObject({
			start: expect.closeTo(5),
			end: expect.closeTo(7),
		});
		expect(p.timeline?.zoomSegments[0]).toMatchObject({
			start: expect.closeTo(8.5),
			end: expect.closeTo(9),
		});
	});

	it("cuts the silence between consecutively cut words and restores words one at a time", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);

		expect(cut(p, recs, "hello", "um", "world")).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.0],
			[2.5, 10],
		]);
		expect(cutRecord(p, "um").bufferStart).toBeCloseTo(0.2);
		expect(cutRecord(p, "world").bufferStart).toBeCloseTo(0.1);

		commitTranscriptCutEdit(p, { restore: [cutRecord(p, "um").id] }, recs);
		expect(clips(p)).toEqual([
			[0, 1.0],
			[1.4, 1.9],
			[2.5, 10],
		]);
		expect(liveWords(p)).toEqual(["um", "again"]);
	});

	it("also cuts a detected pause that sits between two cut words", () => {
		const recs = recordings(10);
		const p = project(
			[
				["a", 0.2, 0.5],
				["b", 1.5, 1.8],
				["c", 3.0, 3.3],
			],
			[clip(0, 10)],
		);

		cut(p, recs, "a", "b");
		expect(clips(p)).toEqual([
			[0, 0.2],
			[1.8, 10],
		]);
		expect(p.captions?.transcriptCuts?.map((cut) => cut.kind).sort()).toEqual([
			"pause",
			"word",
			"word",
		]);
		expect(
			context(p, recs).items.map((item) =>
				item.type === "pause" ? [item.start, item.end] : item.type,
			),
		).toEqual(["cut-word", "cut-pause", "cut-word", [1.8, 3.0], "word"]);
	});

	it("leaves a pause alone when only one of its neighbours is cut now", () => {
		const recs = recordings(40);
		const p = project(
			[
				["show", 1.0, 1.3],
				["you", 1.4, 1.6],
				["okay", 31.6, 31.9],
				["done", 32.0, 32.3],
			],
			[clip(0, 40)],
		);
		cut(p, recs, "you");
		cut(p, recs, "okay");
		expect(clips(p)).toEqual([
			[0, 1.4],
			[1.6, 31.6],
			[31.9, 40],
		]);
		expect(p.captions?.transcriptCuts?.map((cut) => cut.kind)).toEqual([
			"word",
			"word",
		]);
	});

	it("refuses to cut across a clip transition without touching the project", () => {
		const recs = recordings(10);
		const p = project(
			[
				["tail", 4.6, 4.9],
				["head", 5.2, 5.5],
			],
			[clip(0, 5), clip(5, 10)],
			{ transitions: [{ segmentIndex: 1, type: "cross-fade", duration: 1 }] },
		);
		const before = structuredClone(p);

		expect(cut(p, recs, "tail")).toBe("transition");
		expect(p).toEqual(before);
	});

	it("refuses to restore into a boundary that gained a transition", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);
		cut(p, recs, "um");
		p.timeline?.transitions.push({
			segmentIndex: 1,
			type: "cross-fade",
			duration: 0.5,
		});
		const before = structuredClone(p);

		expect(
			commitTranscriptCutEdit(p, { restore: [cutRecord(p, "um").id] }, recs),
		).toBe("transition");
		expect(p).toEqual(before);
	});

	it("fails without changes when a cut would empty the timeline", () => {
		const recs = recordings(10);
		const p = project(
			[
				["only", 1.0, 1.4],
				["words", 1.5, 2.5],
			],
			[clip(1.0, 2.5)],
		);
		const before = structuredClone(p);

		expect(cut(p, recs, "only", "words")).toBe("failed");
		expect(p).toEqual(before);
	});

	it("cuts a word that ends a clip in a later recording despite float drift", () => {
		const recs = recordings(0.17, 1);
		const offset = 0.17;
		const p = project(
			[
				["first", 0.05, 0.15],
				["last", offset + 0.4, offset + 0.61],
			],
			[clip(0, 0.17), clip(0.03, 0.61, { recordingSegment: 1 })],
		);

		expect(cut(p, recs, "last")).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 0.17],
			[0.03, 0.4],
		]);
		commitTranscriptCutEdit(p, { restore: [cutRecord(p, "last").id] }, recs);
		expect(clips(p)).toEqual([
			[0, 0.17],
			[0.03, 0.61],
		]);
	});

	it("keeps clip settings by extending instead of merging differing clips", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);
		cut(p, recs, "um");
		const second = p.timeline?.segments[1];
		if (second) second.volume = 0.5;

		commitTranscriptCutEdit(p, { restore: [cutRecord(p, "um").id] }, recs);
		expect(clips(p)).toEqual([
			[0, 1.9],
			[1.9, 10],
		]);
		expect(p.timeline?.segments[1].volume).toBe(0.5);
	});

	it("follows clip speed when cutting and restoring", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10, { timescale: 2 })]);

		cut(p, recs, "um");
		expect(clipTimelineDuration(p.timeline?.segments ?? [], [])).toBeCloseTo(
			4.85,
		);
		commitTranscriptCutEdit(p, { restore: [cutRecord(p, "um").id] }, recs);
		expect(clipTimelineDuration(p.timeline?.segments ?? [], [])).toBeCloseTo(5);
		expect(clips(p)).toEqual([[0, 10]]);
	});

	it("keeps caption-only deletes out of the cut list", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);

		expect(cut(p, recs, "um")).toBe("applied");
		expect(cutRecord(p, "um")).toMatchObject({ kind: "word", start: 1.6 });
		expect(
			deleteTranscriptWords(p, [
				{ text: "world", start: 2.0, end: 2.5, segmentIndex: 0, wordIndex: 1 },
			]),
		).toBe("deleted");
		expect(p.captions?.transcriptCuts).toHaveLength(1);
		expect(p.captions?.transcriptHidden).toEqual([{ start: 2.0, end: 2.5 }]);
	});
});

describe("transcript cut padding", () => {
	it("grows and shrinks a cut while overlapping cuts keep their footage", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);
		const pad = (text: string, bufferStart: number, bufferEnd: number) =>
			commitTranscriptCutEdit(
				p,
				{ padding: [{ id: cutRecord(p, text).id, bufferStart, bufferEnd }] },
				recs,
			);
		cut(p, recs, "um");

		expect(pad("um", 0, 0.05)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.6],
			[1.95, 10],
		]);
		pad("um", -0.1, 0);
		expect(clips(p)).toEqual([
			[0, 1.7],
			[1.9, 10],
		]);
		pad("um", 0, 0);

		cut(p, recs, "hello");
		expect(cutRecord(p, "hello").bufferEnd).toBeCloseTo(0.2);
		expect(clips(p)).toEqual([
			[0, 1.0],
			[1.9, 10],
		]);
		expect(pad("hello", 0, 0.3)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.0],
			[1.9, 10],
		]);
		pad("hello", 0, 0);
		expect(clips(p)).toEqual([
			[0, 1.0],
			[1.4, 1.6],
			[1.9, 10],
		]);
	});

	it("keeps at least half the cut when both sides shrink", () => {
		expect(cutPaddingLimits({ start: 1.6, end: 1.9 })).toEqual({
			before: { min: -0.15, max: 1 },
			after: { min: -0.15, max: 1 },
		});
		expect(
			cutPaddingLimits({ start: 1.6, end: 1.9, bufferStart: -0.15 }).after.min,
		).toBeCloseTo(0);
		expect(
			cutPaddingLimits({ start: 1, end: 3, bufferEnd: -0.5 }).before.min,
		).toBe(-0.5);

		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);
		cut(p, recs, "um");
		const id = cutRecord(p, "um").id;
		commitTranscriptCutEdit(
			p,
			{ padding: [{ id, bufferStart: -0.15, bufferEnd: -0.15 }] },
			recs,
		);
		const claim = (p.timeline?.segments ?? []).map((segment) => segment.end);
		expect(cutRecord(p, "um").bufferStart).toBeCloseTo(0);
		expect(cutRecord(p, "um").bufferEnd).toBeCloseTo(-0.15);
		expect(claim[0]).toBeCloseTo(1.6);
	});

	it("stops padding at the neighbouring words", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);
		cut(p, recs, "um");
		const record = cutRecord(p, "um");
		expect(cutPaddingRoom(p.captions, record)).toEqual({
			before: expect.closeTo(0.2),
			after: expect.closeTo(0.1),
		});

		commitTranscriptCutEdit(
			p,
			{ padding: [{ id: record.id, bufferStart: 0, bufferEnd: 0.6 }] },
			recs,
		);
		expect(cutRecord(p, "um").bufferEnd).toBeCloseTo(0.1);
		expect(clips(p)).toEqual([
			[0, 1.6],
			[2.0, 10],
		]);
		expect(liveWords(p)).toEqual(["hello", "world", "again"]);
	});

	it("drops the pause between cut words once their padding takes the silence", () => {
		const recs = recordings(10);
		const p = project(
			[
				["hello", 1.0, 1.4],
				["um", 1.6, 1.9],
				["uh", 2.6, 2.8],
				["world", 3.0, 3.4],
			],
			[clip(0, 10)],
		);
		const pauses = () =>
			context(p, recs).items.flatMap((item) =>
				item.type === "pause"
					? [[Number(item.start.toFixed(6)), Number(item.end.toFixed(6))]]
					: [],
			);
		cut(p, recs, "um");
		cut(p, recs, "uh");
		expect(pauses()).toEqual([
			[0, 1],
			[1.9, 2.6],
		]);

		commitTranscriptCutEdit(
			p,
			{
				padding: [
					{ id: cutRecord(p, "um").id, bufferStart: 0, bufferEnd: 0.3 },
					{ id: cutRecord(p, "uh").id, bufferStart: 0.3, bufferEnd: 0 },
				],
			},
			recs,
		);
		expect(clips(p)).toEqual([
			[0, 1.6],
			[2.2, 2.3],
			[2.8, 10],
		]);
		expect(pauses()).toEqual([[0, 1]]);
	});
});

describe("transcript pauses", () => {
	it("lists pauses between words and never restores footage it did not cut", () => {
		const recs = recordings(10);
		const p = project(
			[
				["first", 3.5, 3.9],
				["next", 4.0, 4.3],
			],
			[clip(2, 10)],
		);
		const ctx = context(p, recs);
		const pause = ctx.items.find((item) => item.type === "pause");
		expect(pause).toEqual({ type: "pause", start: 2, end: 3.5 });
		if (pause?.type !== "pause") return;

		expect(commitTranscriptCutEdit(p, planPauseCut(ctx, pause), recs)).toBe(
			"applied",
		);
		expect(clips(p)).toEqual([[3.5, 10]]);
		const record = p.captions?.transcriptCuts?.[0];
		commitTranscriptCutEdit(p, { restore: [record?.id ?? ""] }, recs);
		expect(clips(p)).toEqual([[2, 10]]);
	});

	it("treats a stretched word end as silence without duplicating the caption", () => {
		const recs = recordings(10);
		const p = project(
			[
				["so", 1.0, 5.0],
				["next", 5.05, 5.4],
			],
			[clip(0, 10)],
		);
		const ctx = context(p, recs);
		const pause = ctx.items.find(
			(item) => item.type === "pause" && item.start > 1,
		);
		expect(pause).toEqual({ type: "pause", start: 3.5, end: 5.05 });
		if (pause?.type !== "pause") return;

		commitTranscriptCutEdit(p, planPauseCut(ctx, pause), recs);
		expect(p.captions?.segments[0].words?.[0]).toMatchObject({
			text: "so",
			end: 3.5,
		});
		const record = p.captions?.transcriptCuts?.[0];
		commitTranscriptCutEdit(
			p,
			{ padding: [{ id: record?.id ?? "", bufferStart: 0, bufferEnd: -0.3 }] },
			recs,
		);
		expect(clips(p)).toEqual([
			[0, 3.5],
			[4.75, 10],
		]);
		const track = deriveCaptionTrackSegments(
			p.captions?.segments ?? [],
			p.timeline?.segments ?? [],
			recs,
		);
		expect(
			track.flatMap((segment) => segment.words ?? []).map((word) => word.text),
		).toEqual(["so", "next"]);
	});
});

describe("pauses heard in the recording", () => {
	const SPEECH_DB = -20;
	const ROOM_DB = -58;

	function levels(
		duration: number,
		speech: Array<[number, number]>,
		quiet = ROOM_DB,
		loud = SPEECH_DB,
	) {
		return Array.from({ length: Math.round(duration * 10) }, (_, block) =>
			speech.some(
				([start, end]) => block / 10 < end && (block + 1) / 10 > start,
			)
				? loud
				: quiet,
		);
	}

	function heard(recs: SegmentRecordings[], speech: Array<[number, number]>) {
		return recordingAudio(recs, [
			[{ levels: levels(recs[0].display.duration, speech), offset: 0 }],
		]);
	}

	function audioContext(
		p: Project,
		recs: SegmentRecordings[],
		audio: RecordingAudio,
	) {
		return {
			...transcriptPlanContext(p, recs, undefined, audio),
			createId,
		};
	}

	function pauses(items: readonly TranscriptItem[]) {
		return items.flatMap((item) =>
			item.type === "pause"
				? [[Number(item.start.toFixed(6)), Number(item.end.toFixed(6))]]
				: [],
		);
	}

	const rounded = (ranges: readonly SourceRange[]) =>
		ranges.map((range) => [
			Number(range.start.toFixed(6)),
			Number(range.end.toFixed(6)),
		]);

	it("finds where every track is quiet and where one is audible, across recordings and clip offsets", () => {
		const recs = recordings(4, 2, 1);
		const audio = recordingAudio(recs, [
			[
				{
					levels: levels(4, [
						[0, 1],
						[2, 2.5],
					]),
					offset: 0,
				},
				{ levels: levels(4, [[1.5, 1.7]]), offset: 0.2 },
			],
			[{ levels: levels(2, [[0.5, 1]]), offset: 0 }],
			[],
		]);
		expect(rounded(audio.silence)).toEqual([
			[1, 1.3],
			[1.5, 2],
			[2.5, 4.5],
			[5, 6],
		]);
		expect(rounded(audio.audible)).toEqual([
			[0, 1],
			[1.3, 1.5],
			[2, 2.5],
			[4.5, 5],
		]);
	});

	it("knows neither silence nor sound without waveforms or without speech clearly above the noise", () => {
		const recs = recordings(4);
		const unknown = { silence: [], audible: [] };
		expect(recordingAudio(recs, [])).toEqual(unknown);
		expect(recordingAudio(recs, [[{ levels: [], offset: 0 }]])).toEqual(
			unknown,
		);
		expect(
			recordingAudio(recs, [
				[{ levels: levels(4, [[1, 3]], -50, -50), offset: 0 }],
			]),
		).toEqual(unknown);
		expect(
			recordingAudio(recs, [
				[{ levels: levels(4, [[1, 3]], ROOM_DB, -48), offset: 0 }],
			]),
		).toEqual(unknown);
	});

	it("starts the pause where the audio goes quiet, even under a word stamped late", () => {
		const recs = recordings(8);
		const p = project(
			[
				["these", 1.0, 1.3],
				["two?", 1.3, 3.8],
				["See", 5.0, 5.4],
				["now", 5.4, 5.8],
			],
			[clip(0, 8)],
		);
		const audio = heard(recs, [
			[1.0, 1.2],
			[5.0, 5.8],
		]);
		expect(pauses(context(p, recs).items)).toEqual([
			[0, 1],
			[3.8, 5],
		]);
		const ctx = audioContext(p, recs, audio);
		expect(pauses(ctx.items)).toEqual([
			[0, 1],
			[1.4, 5],
		]);

		const pause = ctx.items.find(
			(item) => item.type === "pause" && item.start > 1,
		);
		if (pause?.type !== "pause") throw new Error("No pause");
		expect(commitTranscriptCutEdit(p, planPauseCut(ctx, pause), recs)).toBe(
			"applied",
		);
		expect(clips(p)).toEqual([
			[0, 1.4],
			[5, 8],
		]);
		expect(liveWords(p)).toEqual(["these", "two?", "See", "now"]);
		expect(p.captions?.segments[0].words?.[1].end).toBeCloseTo(1.4);

		commitTranscriptCutEdit(
			p,
			{ restore: [p.captions?.transcriptCuts?.[0]?.id ?? ""] },
			recs,
		);
		expect(clips(p)).toEqual([[0, 8]]);
		expect(p.captions?.segments[0].words?.[1]).toMatchObject({
			text: "two?",
			end: 3.8,
		});
	});

	it("finds a pause the transcript hides entirely inside a word", () => {
		const recs = recordings(4);
		const p = project(
			[
				["so", 1.0, 2.4],
				["next", 2.4, 2.8],
			],
			[clip(0, 4)],
		);
		const audio = heard(recs, [
			[1.0, 1.4],
			[2.4, 2.8],
		]);
		expect(pauses(context(p, recs).items)).toEqual([[0, 1]]);
		expect(pauses(audioContext(p, recs, audio).items)).toEqual([
			[0, 1],
			[1.5, 2.4],
		]);
	});

	it("never reaches into audio that runs up to the next word", () => {
		const recs = recordings(4);
		const p = project(
			[
				["so", 1.0, 2.4],
				["next", 2.4, 2.8],
			],
			[clip(0, 4)],
		);
		expect(
			pauses(audioContext(p, recs, heard(recs, [[1.0, 2.8]])).items),
		).toEqual([[0, 1]]);
		const early: Array<[number, number]> = [
			[1.0, 1.4],
			[2.3, 2.8],
		];
		expect(pauses(audioContext(p, recs, heard(recs, early)).items)).toEqual([
			[0, 1],
			[1.5, 2.3],
		]);
	});

	it("lets Auto Clean take the silence a stretched word hides before a filler", () => {
		const recs = recordings(5);
		const words: Array<[string, number, number]> = [
			["so", 1.0, 2.0],
			["um", 2.0, 2.3],
			["right", 2.3, 2.7],
		];
		const audio = heard(recs, [
			[1.0, 1.3],
			[2.0, 2.7],
		]);

		const transcriptOnly = project(words, [clip(0, 5)]);
		const plain = planAutoClean(context(transcriptOnly, recs), 5).edit;
		if (!plain) throw new Error("Nothing planned");
		commitTranscriptCutEdit(transcriptOnly, plain, recs);
		expect(clips(transcriptOnly)).toEqual([
			[0, 2],
			[2.3, 5],
		]);

		const p = project(words, [clip(0, 5)]);
		const { edit } = planAutoClean(audioContext(p, recs, audio), 5);
		if (!edit) throw new Error("Nothing planned");
		expect(commitTranscriptCutEdit(p, edit, recs)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.4],
			[2.3, 5],
		]);
		expect(liveWords(p)).toEqual(["so", "right"]);
		expect(p.captions?.segments[0].words?.[0].end).toBeCloseTo(1.4);
	});

	it("keeps speech the transcript missed out of the pauses Auto Clean cuts", () => {
		const recs = recordings(6);
		const p = project(
			[
				["hello", 1.0, 1.4],
				["again", 4.0, 4.4],
			],
			[clip(0, 6)],
		);
		expect(pauses(context(p, recs).items)).toEqual([
			[0, 1],
			[1.4, 4],
		]);
		const ctx = audioContext(
			p,
			recs,
			heard(recs, [
				[1.0, 1.3],
				[2.0, 3.0],
				[4.0, 4.4],
			]),
		);
		expect(pauses(ctx.items)).toEqual([
			[0, 1],
			[1.4, 2],
			[3, 4],
		]);
		expect(planAutoClean(ctx, 1.5)).toEqual({ edit: null, skipped: 0 });

		const { edit } = planAutoClean(ctx, 0.5);
		if (!edit) throw new Error("Nothing planned");
		expect(commitTranscriptCutEdit(p, edit, recs)).toBe("applied");
		expect(clips(p)).toEqual([
			[1, 1.4],
			[2, 3],
			[4, 6],
		]);
	});

	it("cuts a filler with only the quiet beside it, not speech the transcript missed", () => {
		const recs = recordings(6);
		const words: Array<[string, number, number]> = [
			["hello", 1.0, 1.4],
			["um", 4.0, 4.3],
			["right", 4.4, 4.8],
		];

		const transcriptOnly = project(words, [clip(0, 6)]);
		const plain = planAutoClean(context(transcriptOnly, recs), 5).edit;
		if (!plain) throw new Error("Nothing planned");
		commitTranscriptCutEdit(transcriptOnly, plain, recs);
		expect(clips(transcriptOnly)).toEqual([
			[0, 1.4],
			[4.4, 6],
		]);

		const p = project(words, [clip(0, 6)]);
		const audio = heard(recs, [
			[1.0, 1.3],
			[2.0, 3.0],
			[3.9, 4.8],
		]);
		const { edit } = planAutoClean(audioContext(p, recs, audio), 5);
		if (!edit) throw new Error("Nothing planned");
		expect(commitTranscriptCutEdit(p, edit, recs)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 3],
			[4.4, 6],
		]);
		expect(liveWords(p)).toEqual(["hello", "right"]);
	});

	it("leaves a kept word's audible end to it when the filler after it is cut", () => {
		const recs = recordings(5);
		const p = project(
			[
				["hello", 1.0, 1.3],
				["um", 2.0, 2.3],
				["right", 2.3, 2.7],
			],
			[clip(0, 5)],
		);
		const audio = heard(recs, [
			[1.0, 1.6],
			[2.0, 2.7],
		]);
		const { edit } = planAutoClean(audioContext(p, recs, audio), 5);
		if (!edit) throw new Error("Nothing planned");
		expect(commitTranscriptCutEdit(p, edit, recs)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.6],
			[2.3, 5],
		]);
	});

	it("joins cut words across audio an earlier cut already took", () => {
		const recs = recordings(5);
		const p = project(
			[
				["hello", 1.0, 1.4],
				["big", 1.5, 1.8],
				["world", 2.2, 2.5],
			],
			[clip(0, 5)],
		);
		const audio = heard(recs, [
			[1.0, 1.8],
			[1.9, 2.0],
			[2.2, 2.5],
		]);
		const cutWord = (text: string) => {
			const ctx = audioContext(p, recs, audio);
			const edit = planWordCuts(ctx, [token(ctx.items, text)]);
			if (!edit) throw new Error(`Nothing to cut for ${text}`);
			return commitTranscriptCutEdit(p, edit, recs);
		};
		expect(cutWord("big")).toBe("applied");
		commitTranscriptCutEdit(
			p,
			{
				padding: [
					{ id: cutRecord(p, "big").id, bufferStart: 0, bufferEnd: 0.2 },
				],
			},
			recs,
		);
		expect(clips(p)).toEqual([
			[0, 1.5],
			[2, 5],
		]);

		expect(cutWord("world")).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.5],
			[2.5, 5],
		]);
	});

	it("finds the pause after a stretched word when the next word starts between waveform blocks", () => {
		const recs = recordings(5);
		for (const next of [2.5, 2.53, 2.58]) {
			const p = project(
				[
					["the", 1.0, next],
					["and", next, next + 0.4],
				],
				[clip(0, 5)],
			);
			const audio = heard(recs, [
				[1.0, 1.3],
				[next, next + 0.4],
			]);
			expect(pauses(audioContext(p, recs, audio).items)).toEqual([
				[0, 1],
				[1.4, 2.5],
			]);
		}
	});

	it("ends a pause where the next word becomes audible, not at its late stamp", () => {
		const recs = recordings(5);
		const p = project(
			[
				["so", 1.0, 1.3],
				["and", 3.2, 3.6],
			],
			[clip(0, 5)],
		);
		const ctx = audioContext(
			p,
			recs,
			heard(recs, [
				[1.0, 1.3],
				[3.0, 3.6],
			]),
		);
		expect(pauses(ctx.items)).toEqual([
			[0, 1],
			[1.3, 3],
		]);
		const pause = ctx.items.find(
			(item) => item.type === "pause" && item.start > 1,
		);
		if (pause?.type !== "pause") throw new Error("No pause");
		expect(commitTranscriptCutEdit(p, planPauseCut(ctx, pause), recs)).toBe(
			"applied",
		);
		expect(clips(p)).toEqual([
			[0, 1.3],
			[3, 5],
		]);
	});

	it("gives a word back its full length when it was cut after a pause cut trimmed it", () => {
		const recs = recordings(6);
		const speech: Array<[number, number]> = [
			[1.0, 1.3],
			[2.0, 2.5],
			[4.5, 4.9],
		];
		for (const together of [false, true]) {
			const p = project(
				[
					["the", 1.0, 1.3],
					["that", 2.0, 4.5],
					["and", 4.5, 4.9],
				],
				[clip(0, 6)],
			);
			const ctx = audioContext(p, recs, heard(recs, speech));
			const pause = ctx.items.find(
				(item) => item.type === "pause" && item.start > 2,
			);
			if (pause?.type !== "pause") throw new Error("No pause");
			commitTranscriptCutEdit(p, planPauseCut(ctx, pause), recs);
			expect(p.captions?.segments[0].words?.[1].end).toBeCloseTo(2.6);
			expect(cut(p, recs, "that")).toBe("applied");

			const [pauseCut, wordCut] = (p.captions?.transcriptCuts ?? []).map(
				(record) => record.id,
			);
			if (together) {
				commitTranscriptCutEdit(p, { restore: [pauseCut, wordCut] }, recs);
			} else {
				commitTranscriptCutEdit(p, { restore: [pauseCut] }, recs);
				commitTranscriptCutEdit(p, { restore: [wordCut] }, recs);
			}
			expect(clips(p)).toEqual([[0, 6]]);
			expect(p.captions?.segments[0].words?.[1]).toMatchObject({
				text: "that",
				end: 4.5,
			});
		}
	});
});

describe("speech kept out of the captions", () => {
	it("never offers a caption-only deleted word as a pause", () => {
		const recs = recordings(10);
		const p = project(
			[
				["So", 0.5, 0.8],
				["um", 1.0, 1.2],
				["important", 1.3, 1.9],
				["stuff", 2.0, 2.4],
				["you", 2.5, 2.7],
				["know", 2.8, 3.0],
			],
			[clip(0, 10)],
		);
		deleteTranscriptWords(p, [
			{
				text: "important",
				start: 1.3,
				end: 1.9,
				segmentIndex: 0,
				wordIndex: 2,
			},
		]);
		expect(
			context(p, recs).items.some(
				(item) => item.type === "pause" && item.start < 1.9 && item.end > 1.3,
			),
		).toBe(false);

		const { edit } = planAutoClean(context(p, recs), 1.5);
		if (!edit) throw new Error("Nothing planned");
		expect(commitTranscriptCutEdit(p, edit, recs)).toBe("applied");
		expect(
			p.timeline?.segments.some(
				(segment) => segment.start <= 1.3 + 1e-6 && segment.end >= 1.9 - 1e-6,
			),
		).toBe(true);
		expect(liveWords(p)).toEqual(["So", "stuff", "you", "know"]);
	});

	it("treats captions without word timing as speech", () => {
		const recs = recordings(10);
		const p = project(
			[
				["hello", 1.0, 1.4],
				["again", 4.0, 4.4],
			],
			[clip(0, 10)],
		);
		p.captions?.segments.push({
			id: "manual",
			start: 2.0,
			end: 3.6,
			text: "Manual caption",
			words: [],
		});
		expect(
			context(p, recs).items.flatMap((item) =>
				item.type === "pause" ? [[item.start, item.end]] : [],
			),
		).toEqual([
			[0, 1.0],
			[1.4, 2.0],
		]);
	});
});

describe("auto clean", () => {
	it("cuts fillers with their surrounding silence and only long pauses, in one restorable edit", () => {
		const recs = recordings(10);
		const p = project(
			[
				["So", 0.5, 0.8],
				["um,", 1.0, 1.2],
				["I", 1.3, 1.4],
				["think", 1.5, 1.9],
				["yes", 3.9, 4.2],
				["uhh", 5.0, 5.2],
				["right", 5.6, 6.0],
			],
			[clip(0, 10)],
		);
		const { edit, skipped } = planAutoClean(context(p, recs), 1.5);
		expect(skipped).toBe(0);
		if (!edit) throw new Error("Nothing planned");

		expect(commitTranscriptCutEdit(p, edit, recs)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 0.8],
			[1.3, 1.9],
			[3.9, 4.2],
			[5.6, 10],
		]);
		expect(liveWords(p)).toEqual(["So", "I", "think", "yes", "right"]);
		expect(p.captions?.transcriptCuts).toHaveLength(4);

		commitTranscriptCutEdit(
			p,
			{ restore: p.captions?.transcriptCuts?.map((cut) => cut.id) },
			recs,
		);
		expect(clips(p)).toEqual([[0, 10]]);
		expect(liveWords(p)).toEqual([
			"So",
			"um,",
			"I",
			"think",
			"yes",
			"uhh",
			"right",
		]);
	});

	it("has nothing to do without fillers or long pauses", () => {
		const recs = recordings(10);
		const p = project(helloWorld.slice(0, 1), [clip(0, 10)]);
		expect(planAutoClean(context(p, recs), 1.5)).toEqual({
			edit: null,
			skipped: 0,
		});
	});

	it("skips only the cuts that sit next to a clip transition", () => {
		const recs = recordings(10);
		const p = project(
			[
				["Well", 0.5, 0.8],
				["um", 1.0, 1.2],
				["yes", 1.3, 1.6],
				["so", 4.5, 4.7],
				["uh", 4.75, 4.9],
				["right", 5.3, 5.6],
			],
			[clip(0, 5), clip(5, 10)],
			{ transitions: [{ segmentIndex: 1, type: "cross-fade", duration: 0.5 }] },
		);
		const { edit, skipped } = planAutoClean(context(p, recs), 5);
		expect(skipped).toBe(1);
		if (!edit) throw new Error("Nothing planned");
		expect(edit.add?.map((cut) => cut.text)).toEqual(["um"]);
		expect(commitTranscriptCutEdit(p, edit, recs)).toBe("applied");
		expect(liveWords(p)).toEqual(["Well", "yes", "so", "uh", "right"]);
	});

	it("leaves the silence beside a skipped filler alone", () => {
		const recs = recordings(10);
		const p = project(
			[
				["You", 1.0, 1.2],
				["know", 2.0, 2.3],
				["uh", 3.8, 4.2],
				["right", 6.5, 6.8],
			],
			[clip(0, 5), clip(5, 10)],
			{ transitions: [{ segmentIndex: 1, type: "cross-fade", duration: 0.5 }] },
		);
		expect(planAutoClean(context(p, recs), 5)).toEqual({
			edit: null,
			skipped: 1,
		});
	});

	it("does not treat other languages' words as fillers", () => {
		const recs = recordings(10);
		const p = project(
			[
				["Eu", 0.5, 0.7],
				["comprei", 0.8, 1.2],
				["um", 1.3, 1.5],
				["carro", 1.6, 2.0],
			],
			[clip(0, 10)],
		);
		expect(planAutoClean(context(p, recs), 1.5)).toEqual({
			edit: null,
			skipped: 0,
		});
	});
});

describe("exact restore", () => {
	const zoom = (start: number, end: number) => ({
		start,
		end,
		amount: 2,
		mode: "auto" as const,
	});

	function spans(segments: Array<{ start: number; end: number }> | undefined) {
		return (segments ?? []).map(({ start, end }) => [
			Number(start.toFixed(6)),
			Number(end.toFixed(6)),
		]);
	}

	function cutPauseAt(p: Project, recs: SegmentRecordings[], start: number) {
		const ctx = context(p, recs);
		const pause = ctx.items.find(
			(item) => item.type === "pause" && Math.abs(item.start - start) < 1e-6,
		);
		if (pause?.type !== "pause") throw new Error(`No pause at ${start}`);
		return commitTranscriptCutEdit(p, planPauseCut(ctx, pause), recs);
	}

	const restore = (p: Project, recs: SegmentRecordings[], ...ids: string[]) =>
		commitTranscriptCutEdit(p, { restore: ids }, recs);

	const cutIds = (p: Project) =>
		(p.captions?.transcriptCuts ?? []).map((cut) => cut.id);

	const pause = (id: string, start: number, end: number): TranscriptCut => ({
		id,
		kind: "pause",
		text: "",
		start,
		end,
		bufferStart: 0,
		bufferEnd: 0,
		segmentId: null,
	});

	it("puts back the overlays a pause cut deleted or trimmed", () => {
		const recs = recordings(20);
		const p = project(
			[
				["before", 1.0, 1.4],
				["after", 6.0, 6.4],
			],
			[clip(0, 20)],
			{
				zoomSegments: [zoom(2, 3), zoom(4.5, 7)],
				keyboardSegments: [
					{
						id: "keys",
						start: 3,
						end: 3.5,
						displayText: "ab",
						keys: [
							{ key: "a", timeOffset: 0 },
							{ key: "b", timeOffset: 250 },
						],
					},
				],
			},
		);
		const before = structuredClone(p.timeline);

		expect(cutPauseAt(p, recs, 1.4)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 1.4],
			[6.0, 20],
		]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[1.4, 2.4]]);
		expect(p.timeline?.keyboardSegments).toEqual([]);

		expect(restore(p, recs, ...cutIds(p))).toBe("applied");
		expect(clips(p)).toEqual([[0, 20]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual(
			spans(before?.zoomSegments),
		);
		expect(p.timeline?.keyboardSegments).toEqual([
			{
				...before?.keyboardSegments?.[0],
				start: expect.closeTo(3),
				end: expect.closeTo(3.5),
			},
		]);
		expect(p.captions?.transcriptCuts).toEqual([]);
	});

	it("keeps a shrunk cut's overlays for both the part that returns and the part still cut", () => {
		const sorted = (segments: Array<{ start: number; end: number }> = []) =>
			spans(segments).sort((a, b) => a[0] - b[0]);
		const zooms = [
			zoom(1.5, 2.1),
			zoom(2.15, 2.25),
			zoom(2.3, 2.8),
			zoom(3, 4),
			zoom(5.5, 7),
		];
		for (const [bufferStart, bufferEnd, shrunk] of [
			[
				-0.5,
				0,
				[
					[1.5, 2.1],
					[2.15, 2.25],
					[2.3, 2.5],
					[2.5, 3.5],
				],
			],
			[
				-0.5,
				-0.5,
				[
					[1.5, 2.1],
					[2.15, 2.25],
					[2.3, 2.5],
					[2.5, 4],
				],
			],
		] as const) {
			const recs = recordings(10);
			const p = project(
				[
					["first", 1.5, 2.0],
					["next", 6.0, 6.4],
				],
				[clip(0, 10)],
				{ zoomSegments: structuredClone(zooms) },
			);
			cutPauseAt(p, recs, 2);
			const [id] = cutIds(p);
			expect(
				commitTranscriptCutEdit(
					p,
					{ padding: [{ id, bufferStart, bufferEnd }] },
					recs,
				),
			).toBe("applied");
			expect(sorted(p.timeline?.zoomSegments)).toEqual(shrunk);

			expect(restore(p, recs, id)).toBe("applied");
			expect(clips(p)).toEqual([[0, 10]]);
			expect(sorted(p.timeline?.zoomSegments)).toEqual(sorted(zooms));
			expect(p.captions?.transcriptCuts).toEqual([]);
		}
	});

	it("keeps a fullscreen text hold that stays inside a shrunk cut", () => {
		const recs = recordings(10);
		const hold = { ...defaultTextSegment(3, 4), layout: "fullscreen" as const };
		const p = project(
			[
				["intro", 0.5, 1.0],
				["after", 8.0, 8.4],
			],
			[clip(0, 10)],
			{ textSegments: [hold], zoomSegments: [zoom(9.5, 10.5)] },
		);
		cutPauseAt(p, recs, 1);
		const [id] = cutIds(p);
		commitTranscriptCutEdit(
			p,
			{ padding: [{ id, bufferStart: -0.5, bufferEnd: 0 }] },
			recs,
		);
		expect(clips(p)).toEqual([
			[0, 1.5],
			[8, 10],
		]);
		expect(p.timeline?.textSegments).toEqual([]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[2, 3]]);

		restore(p, recs, id);
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.textSegments)).toEqual([[3, 4]]);
		expect(p.timeline?.textSegments[0].layout).toBe("fullscreen");
		expect(spans(p.timeline?.zoomSegments)).toEqual([[9.5, 10.5]]);
	});

	it("shrinks a cut across a speed change and returns both clips exactly", () => {
		const recs = recordings(10);
		const p = project(
			[
				["hello", 0.5, 0.9],
				["next", 5.0, 5.3],
			],
			[clip(0, 2.1), clip(2.1, 10, { timescale: 2 })],
			{ zoomSegments: [zoom(1.2, 1.5), zoom(3, 3.5)] },
		);
		cutPauseAt(p, recs, 0.9);
		const [id] = cutIds(p);
		expect(p.captions?.transcriptCuts?.[0].removed).toHaveLength(2);
		commitTranscriptCutEdit(
			p,
			{ padding: [{ id, bufferStart: -0.5, bufferEnd: 0 }] },
			recs,
		);
		expect(clips(p)).toEqual([
			[0, 1.4],
			[5, 10],
		]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[1.2, 1.4]]);

		restore(p, recs, id);
		expect(clips(p)).toEqual([
			[0, 2.1],
			[2.1, 10],
		]);
		expect(p.timeline?.segments.map((segment) => segment.timescale)).toEqual([
			1, 2,
		]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([
			[1.2, 1.5],
			[3, 3.5],
		]);
	});

	it("hands the rest of a restored cut's footage and overlays to the cut still claiming it", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)], {
			zoomSegments: [zoom(3.2, 3.6)],
		});
		commitTranscriptCutEdit(p, { add: [pause("first", 2, 4)] }, recs);
		commitTranscriptCutEdit(p, { add: [pause("second", 3, 5)] }, recs);
		expect(clips(p)).toEqual([
			[0, 2],
			[5, 10],
		]);

		restore(p, recs, "first");
		expect(clips(p)).toEqual([
			[0, 3],
			[5, 10],
		]);
		expect(p.timeline?.zoomSegments).toEqual([]);

		restore(p, recs, "second");
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[3.2, 3.6]]);
	});

	it("restores an earlier cut's mask movements while a later cut on the same mask stays", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)], {
			maskSegments: [
				{
					...defaultMaskSegment(1, 9),
					keyframes: {
						position: [
							{ time: 0.5, x: 0.1, y: 0.1 },
							{ time: 1.5, x: 0.2, y: 0.2 },
							{ time: 3.0, x: 0.3, y: 0.3 },
							{ time: 4.5, x: 0.4, y: 0.4 },
							{ time: 7.0, x: 0.5, y: 0.5 },
						],
						size: [],
						intensity: [],
					},
				},
			],
		});
		const mask = () => {
			const segment = p.timeline?.maskSegments[0];
			return {
				end: Number(segment?.end.toFixed(6)),
				times: segment?.keyframes?.position?.map((keyframe) =>
					Number(keyframe.time.toFixed(6)),
				),
			};
		};
		commitTranscriptCutEdit(p, { add: [pause("first", 2, 3)] }, recs);
		commitTranscriptCutEdit(p, { add: [pause("second", 5, 6)] }, recs);
		expect(mask()).toEqual({ end: 7, times: [0.5, 2, 5] });

		restore(p, recs, "first");
		expect(clips(p)).toEqual([
			[0, 5],
			[6, 10],
		]);
		expect(mask()).toEqual({ end: 8, times: [0.5, 1.5, 3, 6] });

		restore(p, recs, "second");
		expect(clips(p)).toEqual([[0, 10]]);
		expect(mask()).toEqual({ end: 9, times: [0.5, 1.5, 3, 4.5, 7] });
	});

	it("restores cuts sharing overlays exactly, in any order", () => {
		const recs = recordings(12);
		const words: Array<[string, number, number]> = [
			["intro", 0.2, 0.6],
			["outro", 11.2, 11.6],
		];
		const fresh = () =>
			project(words, [clip(0, 12)], {
				zoomSegments: [zoom(1.5, 10.5), zoom(5.5, 6.5)],
				maskSegments: [
					{
						...defaultMaskSegment(1, 11),
						keyframes: {
							position: [0.5, 1.5, 2.5, 4.5, 5.5, 7.5, 8.5, 9.5].map(
								(time, index) => ({ time, x: index / 10, y: index / 10 }),
							),
							size: [],
							intensity: [],
						},
					},
				],
			});
		const cuts = [pause("a", 2, 3), pause("b", 6, 7), pause("c", 9, 10)];
		const state = (p: Project) => ({
			clips: clips(p),
			zooms: spans(p.timeline?.zoomSegments).sort((x, y) => x[0] - y[0]),
			masks: p.timeline?.maskSegments.map((segment) => ({
				start: Number(segment.start.toFixed(6)),
				end: Number(segment.end.toFixed(6)),
				times: segment.keyframes?.position?.map((keyframe) =>
					Number(keyframe.time.toFixed(6)),
				),
			})),
		});
		const expected = (ids: readonly string[]) => {
			const p = fresh();
			const add = cuts.filter((cut) => ids.includes(cut.id));
			if (add.length > 0) commitTranscriptCutEdit(p, { add }, recs);
			return state(p);
		};
		const orders = [
			["a", "b", "c"],
			["a", "c", "b"],
			["b", "a", "c"],
			["b", "c", "a"],
			["c", "a", "b"],
			["c", "b", "a"],
		];
		for (const batch of [false, true]) {
			for (const order of orders) {
				const p = fresh();
				if (batch) commitTranscriptCutEdit(p, { add: cuts }, recs);
				else
					for (const cut of cuts)
						commitTranscriptCutEdit(p, { add: [cut] }, recs);
				expect(state(p)).toEqual(expected(["a", "b", "c"]));
				const remaining = ["a", "b", "c"];
				for (const id of order) {
					expect(restore(p, recs, id)).toBe("applied");
					remaining.splice(remaining.indexOf(id), 1);
					expect(state(p)).toEqual(expected(remaining));
				}
				expect(p.captions?.transcriptCuts).toEqual([]);
			}
		}
	});

	it("moves an overlay an adjacent cut trimmed when the other cut comes back", () => {
		const recs = recordings(20);
		const p = project(
			[
				["intro", 0.1, 0.3],
				["outro", 19.6, 19.9],
			],
			[clip(0, 20)],
			{ zoomSegments: [zoom(5.15, 8.85)] },
		);
		commitTranscriptCutEdit(p, { add: [pause("first", 2.7, 4.4)] }, recs);
		commitTranscriptCutEdit(p, { add: [pause("second", 4.4, 5.3)] }, recs);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[2.7, 6.25]]);

		restore(p, recs, "first");
		expect(spans(p.timeline?.zoomSegments)).toEqual([[4.4, 7.95]]);

		restore(p, recs, "second");
		expect(spans(p.timeline?.zoomSegments)).toEqual([[5.15, 8.85]]);
	});

	it("restores an earlier cut's zoom trim while a later cut before it stays", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)], {
			zoomSegments: [zoom(2.5, 5.5)],
		});
		commitTranscriptCutEdit(p, { add: [pause("first", 5, 6)] }, recs);
		commitTranscriptCutEdit(p, { add: [pause("second", 2, 3)] }, recs);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[2, 4]]);

		restore(p, recs, "first");
		expect(clips(p)).toEqual([
			[0, 2],
			[3, 10],
		]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[2, 4.5]]);

		restore(p, recs, "second");
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[2.5, 5.5]]);
	});

	it("puts footage cut up to a closing title back ahead of it", () => {
		const recs = recordings(10);
		const p = project(
			[
				["thanks", 8.0, 8.4],
				["bye", 9.0, 9.5],
			],
			[clip(0, 10)],
			{
				textSegments: [
					{ ...defaultTextSegment(10, 12), layout: "fullscreen" as const },
				],
				zoomSegments: [zoom(9.2, 11.5)],
			},
		);
		cut(p, recs, "bye");
		const { id } = cutRecord(p, "bye");
		commitTranscriptCutEdit(
			p,
			{ padding: [{ id, bufferStart: 0, bufferEnd: 0.5 }] },
			recs,
		);
		expect(clips(p)).toEqual([[0, 9]]);
		expect(spans(p.timeline?.textSegments)).toEqual([[9, 11]]);

		expect(restore(p, recs, id)).toBe("applied");
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.textSegments)).toEqual([[10, 12]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[9.2, 11.5]]);
	});

	it("treats a closing title a hair off the clips' end as sitting at it", () => {
		for (const offset of [-1e-12, 1e-12]) {
			const recs = recordings(10);
			const p = project(
				[
					["thanks", 8.0, 8.4],
					["bye", 9.0, 9.5],
				],
				[clip(0, 10)],
				{
					textSegments: [
						{
							...defaultTextSegment(10 + offset, 12),
							layout: "fullscreen" as const,
						},
					],
				},
			);
			cut(p, recs, "bye");
			const { id } = cutRecord(p, "bye");
			commitTranscriptCutEdit(
				p,
				{ padding: [{ id, bufferStart: 0, bufferEnd: 0.5 }] },
				recs,
			);
			expect(spans(p.timeline?.textSegments)).toEqual([[9, 11]]);

			expect(restore(p, recs, id)).toBe("applied");
			expect(clips(p)).toEqual([[0, 10]]);
			expect(spans(p.timeline?.textSegments)).toEqual([[10, 12]]);
		}
	});

	it("keeps a fullscreen hold between two adjacent cuts in either restore order", () => {
		for (const order of [
			["first", "second"],
			["second", "first"],
		]) {
			const recs = recordings(10);
			const p = project(
				[
					["intro", 0.5, 1.0],
					["outro", 9.0, 9.4],
				],
				[clip(0, 10)],
				{
					textSegments: [
						{ ...defaultTextSegment(4, 5), layout: "fullscreen" as const },
					],
					zoomSegments: [zoom(3.5, 6.5)],
				},
			);
			commitTranscriptCutEdit(p, { add: [pause("first", 3, 4)] }, recs);
			commitTranscriptCutEdit(p, { add: [pause("second", 4, 5)] }, recs);
			expect(clips(p)).toEqual([
				[0, 3],
				[5, 10],
			]);
			expect(spans(p.timeline?.textSegments)).toEqual([[3, 4]]);

			expect(restore(p, recs, order[0])).toBe("applied");
			expect(spans(p.timeline?.textSegments)).toEqual([
				order[0] === "first" ? [4, 5] : [3, 4],
			]);
			expect(restore(p, recs, order[1])).toBe("applied");
			expect(clips(p)).toEqual([[0, 10]]);
			expect(spans(p.timeline?.textSegments)).toEqual([[4, 5]]);
			expect(spans(p.timeline?.zoomSegments)).toEqual([[3.5, 6.5]]);
		}
	});

	it("restores a cut that another cut overlaps by a sliver on a sped-up clip", () => {
		const recs = recordings(10);
		const p = project(
			[
				["intro", 0.2, 0.6],
				["outro", 9.2, 9.6],
			],
			[clip(0, 10, { timescale: 2 })],
			{ zoomSegments: [zoom(1.75, 2.25)] },
		);
		commitTranscriptCutEdit(p, { add: [pause("second", 3, 5)] }, recs);
		commitTranscriptCutEdit(p, { add: [pause("first", 2, 3.0015)] }, recs);
		expect(clips(p)).toEqual([
			[0, 2],
			[5, 10],
		]);

		expect(restore(p, recs, "second")).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 2],
			[3, 10],
		]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[1.25, 1.75]]);
		expect(p.captions?.transcriptRemoved).toEqual([{ start: 2, end: 3 }]);

		expect(restore(p, recs, "first")).toBe("applied");
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[1.75, 2.25]]);
	});

	it("returns a word cut across a speed change to the clips it came from", () => {
		const recs = recordings(10);
		const p = project(
			[
				["hello", 0.5, 0.9],
				["word", 2.0, 2.4],
				["next", 5.0, 5.3],
			],
			[clip(0, 2.1), clip(2.1, 10, { timescale: 2 })],
		);

		expect(cut(p, recs, "word")).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 2.0],
			[2.4, 10],
		]);
		expect(cutRecord(p, "word").removed).toHaveLength(2);

		restore(p, recs, cutRecord(p, "word").id);
		expect(clips(p)).toEqual([
			[0, 2.1],
			[2.1, 10],
		]);
		expect(p.timeline?.segments.map((segment) => segment.timescale)).toEqual([
			1, 2,
		]);
	});

	it("gives words back the ends that pause and filler cuts trimmed", () => {
		const recs = recordings(10);
		const stretched = project(
			[
				["so", 1.0, 5.0],
				["next", 5.05, 5.4],
			],
			[clip(0, 10)],
		);
		cutPauseAt(stretched, recs, 3.5);
		expect(stretched.captions?.segments[0].words?.[0].end).toBe(3.5);
		restore(stretched, recs, ...cutIds(stretched));
		expect(stretched.captions?.segments[0].words?.[0]).toMatchObject({
			text: "so",
			end: 5.0,
		});
		expect(clips(stretched)).toEqual([[0, 10]]);

		const filler = project(
			[
				["so", 1.0, 3.8],
				["um", 3.8, 4.1],
				["right", 4.2, 4.5],
			],
			[clip(0, 10)],
		);
		const { edit } = planAutoClean(context(filler, recs), 5);
		if (!edit) throw new Error("Nothing planned");
		commitTranscriptCutEdit(filler, edit, recs);
		expect(liveWords(filler)).toEqual(["so", "right"]);
		expect(filler.captions?.segments[0].words?.[0].end).toBeCloseTo(3.5);

		restore(filler, recs, cutRecord(filler, "um").id);
		expect(
			filler.captions?.segments[0].words?.map((word) => [word.text, word.end]),
		).toEqual([
			["so", 3.8],
			["um", 4.1],
			["right", 4.5],
		]);
		expect(clips(filler)).toEqual([[0, 10]]);
	});

	it("brings back a fullscreen text hold together with the time it held", () => {
		const recs = recordings(10);
		const hold = { ...defaultTextSegment(3, 4), layout: "fullscreen" as const };
		const p = project(
			[
				["intro", 0.5, 1.0],
				["long", 2.5, 3.5],
				["after", 8.0, 8.4],
			],
			[clip(0, 10)],
			{ textSegments: [hold], zoomSegments: [zoom(6, 7)] },
		);

		cut(p, recs, "long");
		expect(p.timeline?.textSegments).toEqual([]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[4, 5]]);

		restore(p, recs, cutRecord(p, "long").id);
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.textSegments)).toEqual([[3, 4]]);
		expect(p.timeline?.textSegments[0].layout).toBe("fullscreen");
		expect(spans(p.timeline?.zoomSegments)).toEqual([[6, 7]]);
	});

	it("restores one Auto Clean cut exactly while its neighbours stay cut", () => {
		const recs = recordings(10);
		const p = project(
			[
				["So", 0.5, 0.8],
				["um,", 1.0, 1.2],
				["I", 1.3, 1.4],
				["think", 1.5, 1.9],
				["yes", 3.9, 4.2],
				["uhh", 5.0, 5.2],
				["right", 5.6, 6.0],
			],
			[clip(0, 10)],
			{
				zoomSegments: [zoom(4.4, 4.8), zoom(7, 8)],
				keyboardSegments: [
					{
						id: "keys",
						start: 5.1,
						end: 5.3,
						displayText: "a",
						keys: [{ key: "a", timeOffset: 0 }],
					},
				],
			},
		);
		const before = structuredClone(p.timeline);
		const { edit } = planAutoClean(context(p, recs), 1.5);
		if (!edit) throw new Error("Nothing planned");
		commitTranscriptCutEdit(p, edit, recs);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[3.1, 4.1]]);
		expect(p.timeline?.keyboardSegments).toEqual([]);

		restore(p, recs, cutRecord(p, "uhh").id);
		expect(clips(p)).toEqual([
			[0, 0.8],
			[1.3, 1.9],
			[3.9, 4.2],
			[5.0, 10],
		]);
		expect(spans(p.timeline?.keyboardSegments)).toEqual([[1.8, 2.0]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[3.7, 4.7]]);

		restore(p, recs, ...cutIds(p));
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual(
			spans(before?.zoomSegments),
		);
		expect(spans(p.timeline?.keyboardSegments)).toEqual(
			spans(before?.keyboardSegments),
		);
		expect(liveWords(p)).toEqual([
			"So",
			"um,",
			"I",
			"think",
			"yes",
			"uhh",
			"right",
		]);
	});

	it("hands footage another cut still claims to that cut and restores it with it", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)], {
			zoomSegments: [zoom(1.45, 1.55), zoom(1.7, 1.8)],
		});
		const before = structuredClone(p.timeline);
		cut(p, recs, "um");
		commitTranscriptCutEdit(
			p,
			{
				padding: [
					{ id: cutRecord(p, "um").id, bufferStart: 0.2, bufferEnd: 0 },
				],
			},
			recs,
		);
		cut(p, recs, "hello");
		expect(cutRecord(p, "hello").bufferEnd).toBeCloseTo(0.2);
		expect(clips(p)).toEqual([
			[0, 1.0],
			[1.9, 10],
		]);
		expect(p.timeline?.zoomSegments).toEqual([]);

		restore(p, recs, cutRecord(p, "um").id);
		expect(clips(p)).toEqual([
			[0, 1.0],
			[1.6, 10],
		]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[1.1, 1.2]]);

		restore(p, recs, cutRecord(p, "hello").id);
		expect(clips(p)).toEqual([[0, 10]]);
		expect(spans(p.timeline?.zoomSegments)).toEqual(
			spans(before?.zoomSegments),
		);
	});

	it("restores a keyboard segment one cut at a time after a cut took all its keys", () => {
		const recs = recordings(20);
		for (const order of [
			["w1", "w3", "w2"],
			["w3", "w1", "w2"],
		]) {
			const p = project(
				[
					["w1", 2.9, 3.4],
					["w2", 3.6, 4.0],
					["w3", 4.4, 4.6],
					["tail", 9.0, 9.5],
				],
				[clip(0, 20)],
				{
					keyboardSegments: [
						{
							id: "keys",
							start: 3,
							end: 6,
							displayText: "ab",
							keys: [
								{ key: "a", timeOffset: 0 },
								{ key: "b", timeOffset: 1500 },
							],
						},
					],
				},
			);
			for (const word of order) cut(p, recs, word);
			expect(p.timeline?.keyboardSegments).toEqual([]);

			expect(restore(p, recs, cutRecord(p, order[0]).id)).toBe("applied");
			expect(restore(p, recs, ...cutIds(p))).toBe("applied");
			expect(clips(p)).toEqual([[0, 20]]);
			expect(
				p.timeline?.keyboardSegments?.map((segment) => [
					...spans([segment])[0],
					segment.displayText,
				]),
			).toEqual([[3, 6, "ab"]]);
		}
	});

	it("takes the sub-millisecond leftover a cut drops at a clip edge and gives it back", () => {
		const recs = recordings(20);
		const p = project(
			[
				["start", 1.0, 1.4],
				["edge", 11.952, 12.236],
				["after", 14.0, 14.4],
			],
			[clip(0, 12.237), clip(12.998, 20)],
			{ zoomSegments: [zoom(11, 15)] },
		);
		expect(cut(p, recs, "edge")).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 11.952],
			[12.998, 20],
		]);
		expect(cutClaim(cutRecord(p, "edge"))?.end).toBeCloseTo(12.237, 6);

		expect(restore(p, recs, cutRecord(p, "edge").id)).toBe("applied");
		expect(clips(p)).toEqual([
			[0, 12.237],
			[12.998, 20],
		]);
		expect(spans(p.timeline?.zoomSegments)).toEqual([[11, 15]]);
	});

	it("gives a restored word its footage back from padding that reached over it", () => {
		const recs = recordings(20);
		const p = project(
			[
				["hello", 1.0, 1.4],
				["it", 3.0, 3.5],
				["world", 6.0, 6.5],
			],
			[clip(0, 20)],
		);
		cut(p, recs, "it");
		expect(cutPauseAt(p, recs, 1.4)).toBe("applied");
		const gap = p.captions?.transcriptCuts?.find(
			(record) => record.kind === "pause",
		);
		if (!gap) throw new Error("No pause cut");
		commitTranscriptCutEdit(
			p,
			{ padding: [{ id: gap.id, bufferStart: 0, bufferEnd: 0.5 }] },
			recs,
		);
		expect(clips(p)).toEqual([
			[0, 1.4],
			[3.5, 20],
		]);

		expect(restore(p, recs, cutRecord(p, "it").id)).toBe("applied");
		expect(liveWords(p)).toEqual(["hello", "it", "world"]);
		expect(clips(p)).toEqual([
			[0, 1.4],
			[3, 20],
		]);
	});

	it("gives a word the rest of its length once the cut still holding it comes back", () => {
		const recs = recordings(10);
		const p = project(
			[
				["it", 1.0, 4.0],
				["next", 4.0, 4.5],
			],
			[clip(0, 10)],
		);
		const cutRange = (start: number, end: number) =>
			commitTranscriptCutEdit(
				p,
				planPauseCut(context(p, recs), { start, end }),
				recs,
			);
		expect(cutRange(2.0, 3.0)).toBe("applied");
		expect(cutRange(3.0, 3.5)).toBe("applied");
		const [first, second] = cutIds(p);

		expect(restore(p, recs, first)).toBe("applied");
		expect(p.captions?.segments[0].words?.[0].end).toBeCloseTo(3.0);
		expect(restore(p, recs, second)).toBe("applied");
		expect(clips(p)).toEqual([[0, 10]]);
		expect(p.captions?.segments[0].words?.[0]).toMatchObject({
			text: "it",
			end: 4,
		});
	});

	it("gives a cut no padding room into a kept word that overlaps it", () => {
		const p = project(
			[
				["um", 3.0, 5.5],
				["and", 5.5, 5.9],
			],
			[clip(0, 8)],
		);
		expect(cutPaddingRoom(p.captions, { start: 3.6, end: 5.5 })).toEqual({
			before: 0,
			after: 0,
		});
	});
});

describe("re-transcription", () => {
	it("keeps cut words cut when captions are generated again", () => {
		const recs = recordings(10);
		const p = project(helloWorld, [clip(0, 10)]);
		cut(p, recs, "um");
		const fresh = structuredClone(p.captions?.segments ?? []);
		fresh[0].words = helloWorld.map(([text, start, end]) => ({
			text,
			start,
			end,
		}));

		applyCaptionResultToProject(p, fresh, recs, 10);
		expect(liveWords(p)).toEqual(["hello", "world", "again"]);
		expect(p.captions?.transcriptCuts).toHaveLength(1);
	});

	it("restores into the caption that is actually there, not a stale id", () => {
		const recs = recordings(20);
		const p = project(
			[
				["alpha", 1.0, 1.3],
				["beta", 1.5, 1.8],
				["gamma", 9.0, 9.3],
				["delta", 9.5, 9.8],
			],
			[clip(0, 20)],
		);
		const segment = (id: string, words: Array<[string, number, number]>) => ({
			id,
			start: words[0][1],
			end: words[words.length - 1][2],
			text: words.map(([text]) => text).join(" "),
			words: words.map(([text, start, end]) => ({ text, start, end })),
		});
		if (p.captions)
			p.captions.segments = [
				segment("segment-0", [
					["alpha", 1.0, 1.3],
					["beta", 1.5, 1.8],
				]),
				segment("segment-1", [
					["gamma", 9.0, 9.3],
					["delta", 9.5, 9.8],
				]),
			];
		cut(p, recs, "gamma");
		applyCaptionResultToProject(
			p,
			[
				segment("segment-0", [["alpha", 1.0, 1.3]]),
				segment("segment-1", [
					["beta", 1.5, 1.8],
					["mid", 4.0, 4.3],
				]),
				segment("segment-2", [
					["gamma", 9.0, 9.3],
					["delta", 9.5, 9.8],
				]),
			],
			recs,
			20,
		);

		commitTranscriptCutEdit(p, { restore: [cutRecord(p, "gamma").id] }, recs);
		const segments = p.captions?.segments ?? [];
		expect(segments.find((s) => s.id === "segment-1")?.end).toBe(4.3);
		expect(
			segments.find((s) => s.words?.some((w) => w.text === "gamma")),
		).toMatchObject({ start: 9.0, end: 9.3 });
		expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length);
	});
});

describe("filler words", () => {
	it("recognises common fillers in any case, punctuation or length", () => {
		for (const word of ["uh", "Um,", "UMMM...", "hmm", "Hmmm?", "erm", "mhm"])
			expect(isFillerWord(word)).toBe(true);
		for (const word of ["under", "the", "hello", "am", "uh-huh", ""])
			expect(isFillerWord(word)).toBe(false);
	});

	it("keeps real words that collapse to a filler", () => {
		for (const word of ["err", "Err,", "ER"])
			expect(isFillerWord(word)).toBe(false);
		for (const word of ["Errr", "er", "UMMM"])
			expect(isFillerWord(word)).toBe(true);
	});

	it("only treats words longer than any spoken word as stretched", () => {
		expect(spokenWordEnd({ start: 1, end: 5 })).toBe(3.5);
		expect(spokenWordEnd({ start: 1, end: 1.4 })).toBe(1.4);
		expect(spokenWordEnd({ start: 1, end: 2 })).toBe(2);
	});

	it("only counts fillers in transcripts that read as English", () => {
		expect(
			readsAsEnglish(["So", "um", "I", "think", "you", "know", "the", "plan"]),
		).toBe(true);
		expect(readsAsEnglish(["Eu", "comprei", "um", "carro", "novo"])).toBe(
			false,
		);
		expect(
			readsAsEnglish(["Er", "kommt", "um", "acht", "Uhr", "nach", "Hause"]),
		).toBe(false);
	});
});
