import {
	type ClipTransition,
	clipTimelineDuration,
	clipTimelineOffsets,
	transitionsAfterClipDelete,
	transitionsAfterClipSplit,
} from "./clip-transitions";

export function shiftTimeAfterCut(
	time: number,
	cutStart: number,
	cutDuration: number,
): number {
	if (time <= cutStart) return time;
	return time - cutDuration;
}

export function shiftCaptionTimesAfterCut(
	segments: Array<{
		start: number;
		end: number;
		words?: Array<{ start: number; end: number }>;
	}>,
	cutStart: number,
	cutDuration: number,
) {
	for (const seg of segments) {
		if (seg.words) {
			for (const w of seg.words) {
				w.start = shiftTimeAfterCut(w.start, cutStart, cutDuration);
				w.end = shiftTimeAfterCut(w.end, cutStart, cutDuration);
			}
			if (seg.words.length > 0) {
				seg.start = seg.words[0].start;
				seg.end = seg.words[seg.words.length - 1].end;
			}
		}
	}
}

export function rippleDeleteFromTrack(
	segments: Array<{ start: number; end: number }>,
	cutStart: number,
	cutEnd: number,
	shiftDuration = cutEnd - cutStart,
) {
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i];
		if (seg.end <= cutStart) {
			continue;
		}
		if (seg.start >= cutEnd) {
			seg.start -= shiftDuration;
			seg.end -= shiftDuration;
		} else if (seg.start >= cutStart && seg.end <= cutEnd) {
			segments.splice(i, 1);
		} else if (seg.start < cutStart && seg.end > cutEnd) {
			seg.end -= shiftDuration;
		} else if (seg.start < cutStart) {
			seg.end = cutStart;
		} else {
			seg.start = cutStart;
			seg.end = Math.max(seg.start, seg.end - shiftDuration);
		}
	}
}

export function cutClipSegmentsForRange(
	segments: Array<{
		timescale: number;
		start: number;
		end: number;
	}>,
	transitions: ClipTransition[],
	cutStart: number,
	cutEnd: number,
	requestedSegmentIndex?: number,
) {
	const editedOffsets = clipTimelineOffsets(segments, transitions);
	let startSegIdx = -1;
	let startRelative = 0;
	let endSegIdx = -1;
	let endRelative = 0;

	for (let i = 0; i < segments.length; i++) {
		if (requestedSegmentIndex !== undefined && i !== requestedSegmentIndex)
			continue;
		const seg = segments[i];
		const duration = (seg.end - seg.start) / seg.timescale;
		const segEditedStart = editedOffsets[i];
		const segEditedEnd = segEditedStart + duration;

		if (cutStart >= segEditedStart && cutStart < segEditedEnd) {
			startSegIdx = i;
			startRelative = (cutStart - segEditedStart) * seg.timescale;
		}
		if (cutEnd > segEditedStart && cutEnd <= segEditedEnd) {
			endSegIdx = i;
			endRelative = (cutEnd - segEditedStart) * seg.timescale;
		}
	}

	if (startSegIdx === -1 || endSegIdx === -1) return transitions;

	if (startSegIdx === endSegIdx) {
		const seg = segments[startSegIdx];
		const beforeEnd = seg.start + startRelative;
		const afterStart = seg.start + endRelative;

		const newSegs: typeof segments = [];
		if (beforeEnd > seg.start + 0.001) {
			newSegs.push({ ...seg, end: beforeEnd });
		}
		if (seg.end > afterStart + 0.001) {
			newSegs.push({ ...seg, start: afterStart });
		}

		segments.splice(startSegIdx, 1, ...newSegs);
		if (newSegs.length === 2) {
			return transitionsAfterClipSplit(transitions, startSegIdx);
		}
		if (newSegs.length === 0) {
			return transitionsAfterClipDelete(transitions, startSegIdx);
		}
		return transitions;
	} else {
		const firstSeg = segments[startSegIdx];
		const lastSeg = segments[endSegIdx];

		firstSeg.end = firstSeg.start + startRelative;
		lastSeg.start = lastSeg.start + endRelative;

		const toRemove: number[] = [];
		if (firstSeg.end <= firstSeg.start + 0.001) toRemove.push(startSegIdx);
		for (let i = startSegIdx + 1; i < endSegIdx; i++) toRemove.push(i);
		if (lastSeg.end <= lastSeg.start + 0.001) toRemove.push(endSegIdx);

		let nextTransitions = transitions;
		for (const idx of toRemove.sort((a, b) => b - a)) {
			nextTransitions = transitionsAfterClipDelete(nextTransitions, idx);
			segments.splice(idx, 1);
		}
		return nextTransitions;
	}
}

export function rippleDeleteAllTracks(
	timeline: {
		segments: Array<{ timescale: number; start: number; end: number }>;
		transitions?: ClipTransition[] | null;
		zoomSegments?: Array<{ start: number; end: number }> | null;
		sceneSegments?: Array<{ start: number; end: number }> | null;
		maskSegments?: Array<{ start: number; end: number }> | null;
		textSegments?: Array<{ start: number; end: number }> | null;
		captionSegments?: Array<{ start: number; end: number }> | null;
		keyboardSegments?: Array<{ start: number; end: number }> | null;
		audioSegments?: Array<{ start: number; end: number }> | null;
	},
	cutStart: number,
	cutEnd: number,
	requestedSegmentIndex?: number,
) {
	const durationBefore = clipTimelineDuration(
		timeline.segments,
		timeline.transitions ?? [],
	);
	timeline.transitions = cutClipSegmentsForRange(
		timeline.segments,
		timeline.transitions ?? [],
		cutStart,
		cutEnd,
		requestedSegmentIndex,
	);
	const shiftDuration = Math.max(
		0,
		durationBefore -
			clipTimelineDuration(timeline.segments, timeline.transitions),
	);
	if (timeline.zoomSegments)
		rippleDeleteFromTrack(
			timeline.zoomSegments,
			cutStart,
			cutEnd,
			shiftDuration,
		);
	if (timeline.sceneSegments)
		rippleDeleteFromTrack(
			timeline.sceneSegments,
			cutStart,
			cutEnd,
			shiftDuration,
		);
	if (timeline.maskSegments)
		rippleDeleteFromTrack(
			timeline.maskSegments,
			cutStart,
			cutEnd,
			shiftDuration,
		);
	if (timeline.textSegments)
		rippleDeleteFromTrack(
			timeline.textSegments,
			cutStart,
			cutEnd,
			shiftDuration,
		);
	if (timeline.captionSegments)
		rippleDeleteFromTrack(
			timeline.captionSegments,
			cutStart,
			cutEnd,
			shiftDuration,
		);
	if (timeline.keyboardSegments)
		rippleDeleteFromTrack(
			timeline.keyboardSegments,
			cutStart,
			cutEnd,
			shiftDuration,
		);
	if (timeline.audioSegments)
		rippleDeleteFromTrack(
			timeline.audioSegments,
			cutStart,
			cutEnd,
			shiftDuration,
		);
}

if (import.meta.vitest) {
	const { expect, it } = import.meta.vitest;

	it("cuts the requested overlap source without discarding the adjacent clip", () => {
		const segments = [
			{ start: 0, end: 4, timescale: 1 },
			{ start: 0, end: 4, timescale: 1 },
			{ start: 0, end: 4, timescale: 1 },
		];
		const transitions: ClipTransition[] = [
			{ segmentIndex: 1, type: "cross-fade", duration: 1 },
			{ segmentIndex: 2, type: "cross-fade", duration: 1 },
		];

		const nextTransitions = cutClipSegmentsForRange(
			segments,
			transitions,
			3.2,
			3.4,
			0,
		);

		expect(segments).toEqual([
			{ start: 0, end: 3.2, timescale: 1 },
			{ start: 3.4, end: 4, timescale: 1 },
			{ start: 0, end: 4, timescale: 1 },
			{ start: 0, end: 4, timescale: 1 },
		]);
		expect(nextTransitions).toEqual([
			{ segmentIndex: 2, type: "cross-fade", duration: 1 },
			{ segmentIndex: 3, type: "cross-fade", duration: 1 },
		]);
	});
}
