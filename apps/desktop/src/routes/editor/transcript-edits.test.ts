import { describe, expect, it } from "vitest";
import { defaultCaptionSettings } from "~/store/captions";
import type { SegmentRecordings } from "~/utils/tauri";
import { deriveCaptionTrackSegments } from "./captions";
import { clipTimelineDuration } from "./clip-transitions";
import type { EditorProjectConfiguration } from "./context";
import {
	deleteTranscriptWords,
	type FlatWord,
	transcriptKeyAction,
	transcriptSeekPosition,
} from "./transcript-edits";

const recordings = [{ display: { duration: 120 } } as SegmentRecordings];

function fixture() {
	const project = {
		captions: {
			settings: { ...defaultCaptionSettings },
			sourceTimed: true,
			segments: [
				{
					id: "first",
					start: 19,
					end: 22,
					text: "keep this caption",
					words: [
						{ text: "keep", start: 19, end: 20 },
						{ text: "this", start: 20, end: 21 },
						{ text: "caption", start: 21, end: 22 },
					],
				},
				{
					id: "later",
					start: 26,
					end: 27,
					text: "later",
					words: [{ text: "later", start: 26, end: 27 }],
				},
				{ id: "manual", start: 28, end: 29, text: "Manual caption", words: [] },
			],
		},
		timeline: {
			segments: [
				{ start: 19, end: 23, timescale: 1, recordingSegment: 0 },
				{ start: 25, end: 30, timescale: 1, recordingSegment: 0 },
			],
			transitions: [],
			zoomSegments: [{ start: 5, end: 7, amount: 2, mode: "auto" }],
			captionSegments: [],
			keyboardSegments: [],
			sceneSegments: [],
			maskSegments: [],
			textSegments: [],
			styleSegments: [],
			imageSegments: [],
			camera3dSegments: [],
		},
	} satisfies Pick<EditorProjectConfiguration, "captions" | "timeline">;
	return project;
}

function word(
	project: ReturnType<typeof fixture>,
	segmentIndex: number,
	wordIndex: number,
): FlatWord {
	return {
		...project.captions.segments[segmentIndex].words[wordIndex],
		segmentIndex,
		wordIndex,
	};
}

describe("transcript word deletion", () => {
	it("deletes caption text without changing cuts, other tracks, duration, or surviving word times", () => {
		const project = fixture();
		const timeline = structuredClone(project.timeline);
		const remaining = [
			project.captions.segments[0].words[0],
			project.captions.segments[0].words[2],
		];
		expect(
			deleteTranscriptWords(project, [word(project, 0, 1)], recordings),
		).toBe("deleted");
		expect(project.timeline).toEqual(timeline);
		expect(clipTimelineDuration(project.timeline.segments, [])).toBe(9);
		expect(project.captions.segments[0].text).toBe("keep caption");
		expect(project.captions.segments[0].words).toEqual(remaining);
		const projected = deriveCaptionTrackSegments(
			project.captions.segments,
			project.timeline.segments,
			recordings,
			[],
		);
		expect(projected.find((segment) => segment.id === "later")?.start).toBe(5);
		expect((projected[0].words ?? []).map((value) => value.text)).toEqual([
			"keep",
			"caption",
		]);
	});

	it("handles multiple words and removes empty captions without deleting unrelated manual captions", () => {
		const project = fixture();
		const timeline = structuredClone(project.timeline);
		deleteTranscriptWords(
			project,
			[word(project, 0, 0), word(project, 1, 0), word(project, 0, 2)],
			recordings,
		);
		expect(project.timeline).toEqual(timeline);
		expect(project.captions.segments.map((segment) => segment.text)).toEqual([
			"this",
			"Manual caption",
		]);
		expect(project.captions.segments[0]).toMatchObject({ start: 20, end: 21 });
	});

	it("keeps ripple deletion available only through the explicit video action", () => {
		const project = fixture();
		deleteTranscriptWords(project, [word(project, 0, 1)], recordings, "video");
		expect(clipTimelineDuration(project.timeline.segments, [])).toBe(8);
		expect(project.timeline.segments).toHaveLength(3);
		expect(project.timeline.zoomSegments[0]).toMatchObject({
			start: 4,
			end: 6,
		});
	});

	it("allows caption edits near transitions while leaving unsafe video cuts untouched", () => {
		const project: Pick<EditorProjectConfiguration, "captions" | "timeline"> =
			fixture();
		const timeline = project.timeline;
		if (!timeline) throw new Error("Missing fixture timeline");
		timeline.transitions = [
			{ segmentIndex: 1, type: "cross-fade", duration: 2 },
		];
		const selected = {
			text: "caption",
			start: 21,
			end: 22,
			segmentIndex: 0,
			wordIndex: 2,
		};
		const before = structuredClone(project);
		expect(
			deleteTranscriptWords(project, [selected], recordings, "video"),
		).toBe("transition");
		expect(project).toEqual(before);
		expect(deleteTranscriptWords(project, [selected], recordings)).toBe(
			"deleted",
		);
		expect(project.timeline).toEqual(before.timeline);
	});
});

describe("transcript seeking", () => {
	it("keeps the viewport stationary when selecting visible words", () => {
		for (const time of [48, 49.5, 55, 61]) {
			expect(transcriptSeekPosition(time, 48, 13)).toBe(48);
		}
	});

	it("reveals offscreen words without scrolling before the start", () => {
		expect(transcriptSeekPosition(70, 48, 13)).toBe(63.5);
		expect(transcriptSeekPosition(1, 48, 13)).toBe(0);
	});
});

describe("transcript keyboard actions", () => {
	const key = (
		key: string,
		shiftKey = false,
		modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
	) => ({
		key,
		shiftKey,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...modifiers,
	});

	it("offers caption deletion and video cuts from the keyboard", () => {
		for (const name of ["Backspace", "Delete"]) {
			expect(transcriptKeyAction(key(name), 1, true)).toBe("delete");
			expect(transcriptKeyAction(key(name, true), 1, true)).toBe("cut");
			expect(transcriptKeyAction(key(name, true), 3, false)).toBe("cut");
		}
	});

	it("only cuts video for Shift without other modifiers", () => {
		for (const name of ["Backspace", "Delete"]) {
			for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
				expect(
					transcriptKeyAction(key(name, true, { [modifier]: true }), 1, true),
				).toBe("delete");
				expect(
					transcriptKeyAction(key(name, false, { [modifier]: true }), 1, true),
				).toBe("delete");
			}
		}
	});

	it("leaves Enter to focused word action buttons", () => {
		expect(transcriptKeyAction(key("Enter"), 1, true)).toBe("edit");
		expect(transcriptKeyAction(key("Enter"), 1, false)).toBeNull();
		expect(transcriptKeyAction(key("Enter"), 2, true)).toBeNull();
	});

	it("ignores keys without a selection", () => {
		for (const name of ["Enter", "Backspace", "Delete", "ArrowLeft"]) {
			expect(transcriptKeyAction(key(name, true), 0, true)).toBeNull();
		}
		expect(transcriptKeyAction(key(" "), 1, true)).toBeNull();
	});
});
