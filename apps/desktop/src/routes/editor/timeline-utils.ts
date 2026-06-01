export function shiftTimeAfterCut(
	time: number,
	cutStart: number,
	cutDuration: number,
): number {
	if (time <= cutStart) return time;
	if (time <= cutStart + cutDuration) return cutStart;
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

	if (startSegIdx === -1) return;

	if (endSegIdx === -1) {
		endSegIdx = segments.length - 1;
		endRelative = segments[endSegIdx].end - segments[endSegIdx].start;
	}

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

export function shiftTimeAfterInsert(
	time: number,
	insertPoint: number,
	duration: number,
): number {
	if (time <= insertPoint) return time;
	return time + duration;
}

export function shiftCaptionTimesAfterInsert(
	segments: Array<{
		start: number;
		end: number;
		words?: Array<{ start: number; end: number }>;
	}>,
	insertPoint: number,
	duration_arg: number,
) {
	for (const seg of segments) {
		if (seg.words) {
			for (const w of seg.words) {
				w.start = shiftTimeAfterInsert(w.start, insertPoint, duration_arg);
				w.end = shiftTimeAfterInsert(w.end, insertPoint, duration_arg);
			}
			if (seg.words.length > 0) {
				seg.start = seg.words[0].start;
				seg.end = seg.words[seg.words.length - 1].end;
			}
		}
	}
}

export function rippleInsertIntoTrack(
	segments: Array<{ start: number; end: number }>,
	insertPoint: number,
	duration: number,
) {
	for (const seg of segments) {
		if (seg.start >= insertPoint) {
			seg.start += duration;
			seg.end += duration;
		} else if (seg.end > insertPoint) {
			seg.end += duration;
		}
	}
}

export function insertClipSegmentForRange(
	segments: Array<{ timescale: number; start: number; end: number }>,
	insertPoint: number,
	duration: number,
) {
	let editedOffset = 0;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const segDuration = (seg.end - seg.start) / seg.timescale;
		const segEditedEnd = editedOffset + segDuration;

		if (insertPoint <= segEditedEnd) {
			const relativeInSeg = (insertPoint - editedOffset) * seg.timescale;
			const splitPoint = seg.start + relativeInSeg;
			const insertAmount = duration * seg.timescale;

			if (splitPoint <= seg.start + 0.001) {
				seg.start -= insertAmount;
			} else if (splitPoint >= seg.end - 0.001) {
				seg.end += insertAmount;
			} else {
				const originalEnd = seg.end;
				seg.end = splitPoint;
				const insertedSeg = {
					timescale: seg.timescale,
					start: splitPoint,
					end: splitPoint + insertAmount,
				};
				const afterSeg = {
					timescale: seg.timescale,
					start: splitPoint + insertAmount,
					end: originalEnd + insertAmount,
				};
				segments.splice(i + 1, 0, insertedSeg, afterSeg);
			}
			return;
		}
		editedOffset += segDuration;
	}

	if (segments.length > 0) {
		const lastSeg = segments[segments.length - 1];
		lastSeg.end += duration * lastSeg.timescale;
	}
}

export function rippleInsertAllTracks(
	timeline: {
		segments: Array<{ timescale: number; start: number; end: number }>;
		zoomSegments?: Array<{ start: number; end: number }> | null;
		sceneSegments?: Array<{ start: number; end: number }> | null;
		maskSegments?: Array<{ start: number; end: number }> | null;
		textSegments?: Array<{ start: number; end: number }> | null;
		captionSegments?: Array<{ start: number; end: number }> | null;
		keyboardSegments?: Array<{ start: number; end: number }> | null;
	},
	insertPoint: number,
	duration: number,
) {
	insertClipSegmentForRange(timeline.segments, insertPoint, duration);
	if (timeline.zoomSegments)
		rippleInsertIntoTrack(timeline.zoomSegments, insertPoint, duration);
	if (timeline.sceneSegments)
		rippleInsertIntoTrack(timeline.sceneSegments, insertPoint, duration);
	if (timeline.maskSegments)
		rippleInsertIntoTrack(timeline.maskSegments, insertPoint, duration);
	if (timeline.textSegments)
		rippleInsertIntoTrack(timeline.textSegments, insertPoint, duration);
	if (timeline.captionSegments)
		rippleInsertIntoTrack(timeline.captionSegments, insertPoint, duration);
	if (timeline.keyboardSegments)
		rippleInsertIntoTrack(timeline.keyboardSegments, insertPoint, duration);
}
