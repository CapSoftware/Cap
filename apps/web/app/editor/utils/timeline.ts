import type { TimelineSegment } from "../types/project-config";

const MIN_SEGMENT_DURATION = 0.1;
const MIN_SPLIT_DISTANCE = 0.01;

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

export function trimSegmentStart(
	segments: ReadonlyArray<TimelineSegment>,
	index: number,
	nextStart: number,
): TimelineSegment[] | null {
	const segment = segments[index];
	if (!segment) return null;

	const previousSegment = index > 0 ? segments[index - 1] : undefined;
	const minStart = previousSegment?.end ?? 0;
	const maxStart = segment.end - MIN_SEGMENT_DURATION;
	const start = clamp(nextStart, minStart, maxStart);

	return segments.map((candidate, candidateIndex) =>
		candidateIndex === index ? { ...candidate, start } : candidate,
	);
}

export function trimSegmentEnd(
	segments: ReadonlyArray<TimelineSegment>,
	index: number,
	nextEnd: number,
	duration: number,
): TimelineSegment[] | null {
	const segment = segments[index];
	if (!segment) return null;

	const nextSegment =
		index + 1 < segments.length ? segments[index + 1] : undefined;
	const minEnd = segment.start + MIN_SEGMENT_DURATION;
	const maxEnd = Math.min(duration, nextSegment?.start ?? duration);
	const end = clamp(nextEnd, minEnd, maxEnd);

	return segments.map((candidate, candidateIndex) =>
		candidateIndex === index ? { ...candidate, end } : candidate,
	);
}

export interface SplitAtTimeResult {
	segments: TimelineSegment[];
	selectionIndex: number;
}

export function splitSegmentAtSourceTime(
	segments: ReadonlyArray<TimelineSegment>,
	sourceTime: number,
): SplitAtTimeResult | null {
	if (!Number.isFinite(sourceTime)) return null;

	const segmentIndex = segments.findIndex(
		(segment) =>
			sourceTime > segment.start + MIN_SPLIT_DISTANCE &&
			sourceTime < segment.end - MIN_SPLIT_DISTANCE,
	);

	if (segmentIndex === -1) return null;
	const segment = segments[segmentIndex];
	if (!segment) return null;

	const firstHalf: TimelineSegment = { ...segment, end: sourceTime };
	const secondHalf: TimelineSegment = { ...segment, start: sourceTime };

	return {
		segments: [
			...segments.slice(0, segmentIndex),
			firstHalf,
			secondHalf,
			...segments.slice(segmentIndex + 1),
		],
		selectionIndex: segmentIndex + 1,
	};
}
