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
) {
	const cutDuration = cutEnd - cutStart;
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i];
		if (seg.end <= cutStart) {
			continue;
		}
		if (seg.start >= cutEnd) {
			seg.start -= cutDuration;
			seg.end -= cutDuration;
		} else if (seg.start >= cutStart && seg.end <= cutEnd) {
			segments.splice(i, 1);
		} else if (seg.start < cutStart && seg.end > cutEnd) {
			seg.end -= cutDuration;
		} else if (seg.start < cutStart) {
			seg.end = cutStart;
		} else {
			seg.start = cutStart;
			seg.end -= cutDuration;
		}
	}
}

export function cutClipSegmentsForRange(
	segments: Array<{
		timescale: number;
		start: number;
		end: number;
	}>,
	cutStart: number,
	cutEnd: number,
) {
	let editedOffset = 0;
	let startSegIdx = -1;
	let startRelative = 0;
	let endSegIdx = -1;
	let endRelative = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const duration = (seg.end - seg.start) / seg.timescale;
		const segEditedStart = editedOffset;
		const segEditedEnd = editedOffset + duration;

		if (startSegIdx === -1 && cutStart < segEditedEnd) {
			startSegIdx = i;
			startRelative = (cutStart - segEditedStart) * seg.timescale;
		}
		if (cutEnd <= segEditedEnd) {
			endSegIdx = i;
			endRelative = (cutEnd - segEditedStart) * seg.timescale;
			break;
		}
		editedOffset += duration;
	}

	if (startSegIdx === -1 || endSegIdx === -1) return;

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
	} else {
		const firstSeg = segments[startSegIdx];
		const lastSeg = segments[endSegIdx];

		firstSeg.end = firstSeg.start + startRelative;
		lastSeg.start = lastSeg.start + endRelative;

		const toRemove: number[] = [];
		if (firstSeg.end <= firstSeg.start + 0.001) toRemove.push(startSegIdx);
		for (let i = startSegIdx + 1; i < endSegIdx; i++) toRemove.push(i);
		if (lastSeg.end <= lastSeg.start + 0.001) toRemove.push(endSegIdx);

		for (const idx of toRemove.sort((a, b) => b - a)) {
			segments.splice(idx, 1);
		}
	}
}

export function rippleDeleteAllTracks(
	timeline: {
		segments: Array<{ timescale: number; start: number; end: number }>;
		zoomSegments?: Array<{ start: number; end: number }> | null;
		sceneSegments?: Array<{ start: number; end: number }> | null;
		maskSegments?: Array<{ start: number; end: number }> | null;
		textSegments?: Array<{ start: number; end: number }> | null;
		captionSegments?: Array<{ start: number; end: number }> | null;
		keyboardSegments?: Array<{ start: number; end: number }> | null;
	},
	cutStart: number,
	cutEnd: number,
) {
	cutClipSegmentsForRange(timeline.segments, cutStart, cutEnd);
	if (timeline.zoomSegments)
		rippleDeleteFromTrack(timeline.zoomSegments, cutStart, cutEnd);
	if (timeline.sceneSegments)
		rippleDeleteFromTrack(timeline.sceneSegments, cutStart, cutEnd);
	if (timeline.maskSegments)
		rippleDeleteFromTrack(timeline.maskSegments, cutStart, cutEnd);
	if (timeline.textSegments)
		rippleDeleteFromTrack(timeline.textSegments, cutStart, cutEnd);
	if (timeline.captionSegments)
		rippleDeleteFromTrack(timeline.captionSegments, cutStart, cutEnd);
	if (timeline.keyboardSegments)
		rippleDeleteFromTrack(timeline.keyboardSegments, cutStart, cutEnd);
}
