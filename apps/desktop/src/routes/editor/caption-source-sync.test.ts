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
});
