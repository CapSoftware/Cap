import type { ZoomMode, ZoomSegment } from "~/utils/tauri";
import { sortTrackSegments } from "./timelineTracks";

export function cloneZoomMode(mode: ZoomMode): ZoomMode {
	if (typeof mode === "object" && mode !== null && "manual" in mode) {
		return {
			manual: {
				x: mode.manual.x,
				y: mode.manual.y,
			},
		};
	}
	return mode;
}

export function splitZoomSegmentsList(
	segments: ZoomSegment[],
	index: number,
	time: number,
): boolean {
	const segment = segments[index];
	if (!segment) return false;

	const newLengths = [segment.end - segment.start - time, time];
	if (newLengths.some((l) => l < 1)) return false;

	segments.splice(index + 1, 0, {
		...segment,
		mode: cloneZoomMode(segment.mode),
		start: segment.start + time,
		end: segment.end,
	});
	segments[index].end = segment.start + time;
	sortTrackSegments(segments);
	return true;
}
