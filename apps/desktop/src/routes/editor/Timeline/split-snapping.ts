// Pure geometry for split-mode snapping on the timeline. All times are in
// output (rendered) time, the domain every non-clip track stores directly and
// the clip track draws in; the caller converts the pixel snap radius via
// secsPerPixel. Targets within EDGE_EPSILON of the hovered clip's edges are
// rejected — snapping there would cut off a near-zero-length piece.

import type { TimelineConfiguration } from "~/utils/tauri";

export const SPLIT_SNAP_PX = 7;
export const SPLIT_EDGE_EPSILON = 0.05;

export type SplitSnapResult = {
	time: number;
	snapped: { time: number } | null;
};

const BOUNDARY_TRACKS = [
	"styleSegments",
	"imageSegments",
	"zoomSegments",
	"sceneSegments",
	"camera3dSegments",
	"textSegments",
	"maskSegments",
	"captionSegments",
	"keyboardSegments",
	"audioSegments",
] as const;

export function snapSplitTime(
	raw: number,
	clipStart: number,
	clipEnd: number,
	radius: number,
	timeline: TimelineConfiguration | null | undefined,
	playhead: number,
): SplitSnapResult {
	const min = clipStart + SPLIT_EDGE_EPSILON;
	const max = clipEnd - SPLIT_EDGE_EPSILON;
	let best: number | null = null;
	let bestDist = Number.POSITIVE_INFINITY;

	const consider = (t: number) => {
		if (t < min || t > max) return;
		const dist = Math.abs(t - raw);
		if (dist > radius) return;
		if (dist < bestDist || (dist === bestDist && best !== null && t < best)) {
			bestDist = dist;
			best = t;
		}
	};

	consider(playhead);
	if (timeline) {
		for (const key of BOUNDARY_TRACKS) {
			const segments = timeline[key];
			if (!segments) continue;
			for (const segment of segments) {
				consider(segment.start);
				consider(segment.end);
			}
		}
	}

	return best === null
		? { time: raw, snapped: null }
		: { time: best, snapped: { time: best } };
}
