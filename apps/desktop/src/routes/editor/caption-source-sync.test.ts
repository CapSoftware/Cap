import { describe, expect, it } from "vitest";
import type {
	CaptionSegment,
	SegmentRecordings,
	TimelineSegment,
} from "~/utils/tauri";
import {
	deriveCaptionTrackSegments,
	syncCaptionSourceFromTrack,
} from "./captions";

function caption(id: string, start: number, end: number, text: string) {
	return {
		id,
		start,
		end,
		text,
		words: [{ text, start, end }],
	} as CaptionSegment;
}

describe("syncCaptionSourceFromTrack", () => {
	it("writes a track edit to its own source caption after a cut", () => {
		const recordings = [{ display: { duration: 10 } } as SegmentRecordings];
		const segments = [
			{ start: 2.5, end: 10, timescale: 1, recordingSegment: 0 },
		] as TimelineSegment[];
		const sources = [
			caption("a", 0, 2, "first"),
			caption("b", 3, 5, "second"),
			caption("c", 6, 8, "third"),
		];
		const project = {
			captions: { segments: sources },
			timeline: {
				segments,
				captionSegments: deriveCaptionTrackSegments(
					sources,
					segments,
					recordings,
				),
			},
		};
		const track = project.timeline.captionSegments;
		expect(track.map((segment) => segment.text)).toEqual(["second", "third"]);

		track[0].text = "edited second";
		track[0].start += 0.1;
		syncCaptionSourceFromTrack(project, 0, recordings);

		const [first, second, third] = project.captions.segments;
		expect(first).toEqual(caption("a", 0, 2, "first"));
		expect(second.text).toBe("edited second");
		expect(second.start).toBeCloseTo(3.1);
		expect(second.end).toBeCloseTo(5);
		expect(second.words?.map((word) => word.text).join(" ")).toBe(
			"edited second",
		);
		expect(third.text).toBe("third");

		const rederived = deriveCaptionTrackSegments(
			project.captions.segments,
			segments,
			recordings,
			track,
		);
		expect(rederived.map((segment) => segment.text)).toEqual([
			"edited second",
			"third",
		]);
	});

	it("keeps the other piece of a caption a cut split in two", () => {
		const recordings = [{ display: { duration: 10 } } as SegmentRecordings];
		const segments = [
			{ start: 0, end: 1.9, timescale: 1, recordingSegment: 0 },
			{ start: 2.1, end: 10, timescale: 1, recordingSegment: 0 },
		] as TimelineSegment[];
		const sources = [
			{
				id: "a",
				start: 0,
				end: 4,
				text: "one two three four",
				words: [
					{ text: "one", start: 0, end: 1 },
					{ text: "two", start: 1, end: 1.8 },
					{ text: "three", start: 2.2, end: 3 },
					{ text: "four", start: 3, end: 4 },
				],
			} as CaptionSegment,
		];
		const project = {
			captions: { segments: sources },
			timeline: {
				segments,
				captionSegments: deriveCaptionTrackSegments(
					sources,
					segments,
					recordings,
				),
			},
		};
		const track = project.timeline.captionSegments;
		expect(track.map((segment) => segment.text)).toEqual([
			"one two",
			"three four",
		]);

		track[1].text = "three five";
		syncCaptionSourceFromTrack(project, 1, recordings);

		const [source] = project.captions.segments;
		expect(source.text).toBe("one two three five");
		expect(source.start).toBe(0);
		expect(source.words?.slice(0, 2)).toEqual([
			{ text: "one", start: 0, end: 1 },
			{ text: "two", start: 1, end: 1.8 },
		]);
		expect(
			deriveCaptionTrackSegments(
				project.captions.segments,
				segments,
				recordings,
				track,
			).map((segment) => segment.text),
		).toEqual(["one two", "three five"]);
	});

	it("leaves a word a cut runs through alone when the other piece is edited", () => {
		const recordings = [{ display: { duration: 10 } } as SegmentRecordings];
		const segments = [
			{ start: 0, end: 1.5, timescale: 1, recordingSegment: 0 },
			{ start: 1.7, end: 10, timescale: 1, recordingSegment: 0 },
		] as TimelineSegment[];
		const source = () =>
			[
				{
					id: "a",
					start: 0,
					end: 3,
					text: "one two three",
					words: [
						{ text: "one", start: 0, end: 1 },
						{ text: "two", start: 1, end: 2 },
						{ text: "three", start: 2, end: 3 },
					],
				},
			] as CaptionSegment[];
		const edit = (text: string, piece = 1) => {
			const sources = source();
			const project = {
				captions: { segments: sources },
				timeline: {
					segments,
					captionSegments: deriveCaptionTrackSegments(
						sources,
						segments,
						recordings,
					),
				},
			};
			const track = project.timeline.captionSegments;
			expect(track.map((segment) => segment.text)).toEqual([
				"one two",
				"two three",
			]);
			track[piece].text = text;
			syncCaptionSourceFromTrack(project, piece, recordings);
			return deriveCaptionTrackSegments(
				project.captions.segments,
				segments,
				recordings,
				track,
			).map((segment) => segment.text);
		};

		expect(edit("two three four")).toEqual(["one two", "two three four"]);
		expect(edit("two tree")).toEqual(["one two", "two tree"]);
		expect(edit("too three")).toEqual(["one too", "too three"]);
		expect(edit("one extra two", 0)).toEqual(["one extra two", "two three"]);
	});
});
