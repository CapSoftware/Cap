import { sortTrackSegments } from "./timelineTracks";

type ZoomSegmentLike = {
	start: number;
	end: number;
};

export type SplitZoomResult<ZoomSegment extends ZoomSegmentLike> = {
	segments: ZoomSegment[];
	// Post-sort index of the newly created (right) piece, so callers can keep
	// the user's selection pointing at the segment they split instead of
	// whichever piece the sort left at the old position.
	newSegmentIndex: number;
};

export function splitZoomSegmentAt<ZoomSegment extends ZoomSegmentLike>(
	segments: ZoomSegment[],
	index: number,
	time: number,
): SplitZoomResult<ZoomSegment> | null {
	const segment = segments[index];
	if (!segment) return null;

	const newLengths = [segment.end - segment.start - time, time];
	if (newLengths.some((l) => l < 1)) return null;

	segments.splice(index + 1, 0, {
		...segment,
		start: segment.start + time,
		end: segment.end,
	});
	segments[index].end = segment.start + time;

	const inserted = segments[index + 1];
	const newSegmentIndex = sortTrackSegments(segments).indexOf(inserted);
	if (newSegmentIndex === -1) return null;

	return { segments, newSegmentIndex };
}
