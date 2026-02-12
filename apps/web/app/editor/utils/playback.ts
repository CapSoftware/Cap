import type { TimelineSegment } from "../types/project-config";

const SEGMENT_EPSILON = 0.001;

export function findSegmentIndexAtTime(
	segments: ReadonlyArray<TimelineSegment>,
	time: number,
): number {
	for (const [index, segment] of segments.entries()) {
		if (
			time >= segment.start - SEGMENT_EPSILON &&
			time < segment.end - SEGMENT_EPSILON
		) {
			return index;
		}
	}

	return -1;
}

export function findNextSegmentIndex(
	segments: ReadonlyArray<TimelineSegment>,
	time: number,
): number {
	for (const [index, segment] of segments.entries()) {
		if (segment.start >= time - SEGMENT_EPSILON) {
			return index;
		}
	}

	return -1;
}
