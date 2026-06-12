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
		words?: Array<{ start: number; end: number; deleted?: boolean }>;
	}>,
	cutStart: number,
	cutDuration: number,
) {
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg.words) {
			for (let j = 0; j < seg.words.length; j++) {
				const w = seg.words[j];

				if (w.deleted) {
					if (
						w.start >= cutStart - 0.001 &&
						w.end <= cutStart + cutDuration + 0.001
					) {
						continue;
					}
					const duration = w.end - w.start;
					w.start = shiftTimeAfterCut(w.start, cutStart, cutDuration);
					w.end = w.start + duration;
				} else {
					w.start = shiftTimeAfterCut(w.start, cutStart, cutDuration);
					w.end = shiftTimeAfterCut(w.end, cutStart, cutDuration);
				}
			}
			if (seg.words.length > 0) {
				const visible = seg.words.filter((w) => !w.deleted);
				if (visible.length > 0) {
					seg.start = visible[0].start;
					seg.end = visible[visible.length - 1].end;
				}
			}
		}
	}
}

const SEGMENT_EPSILON = 0.001;

export function cleanupDegenerateSegments(
	segments: Array<{ start: number; end: number }>,
) {
	for (let i = segments.length - 1; i >= 0; i--) {
		if (segments[i].end - segments[i].start < SEGMENT_EPSILON) {
			segments.splice(i, 1);
		}
	}
}

export function cleanupDegenerateClipSegments(
	segments: Array<{ timescale: number; start: number; end: number }>,
) {
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i];
		if ((seg.end - seg.start) / seg.timescale < SEGMENT_EPSILON) {
			segments.splice(i, 1);
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
	cleanupDegenerateSegments(segments);
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
	cleanupDegenerateClipSegments(segments);
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
	if (time < insertPoint - 0.001) return time;
	return time + duration;
}

export function shiftCaptionTimesAfterInsert(
	segments: Array<{
		start: number;
		end: number;
		words?: Array<{ start: number; end: number; deleted?: boolean }>;
	}>,
	insertPoint: number,
	duration_arg: number,
) {
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg.words) {
			for (let j = 0; j < seg.words.length; j++) {
				const w = seg.words[j];

				if (w.deleted) {
					if (
						w.start >= insertPoint - 0.001 &&
						w.end <= insertPoint + duration_arg + 0.001
					) {
						continue;
					}
				}
				const duration = w.end - w.start;
				w.start = shiftTimeAfterInsert(w.start, insertPoint, duration_arg);
				w.end = w.start + duration;
			}
			if (seg.words.length > 0) {
				const visible = seg.words.filter((w) => !w.deleted);
				if (visible.length > 0) {
					seg.start = visible[0].start;
					seg.end = visible[visible.length - 1].end;
				}
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
	cleanupDegenerateSegments(segments);
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
				seg.start = Math.max(0, seg.start - insertAmount);
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
	cleanupDegenerateClipSegments(segments);
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

if (import.meta.vitest) {
	const { describe, expect, it } = import.meta.vitest;

	describe("shiftTimeAfterCut", () => {
		it("does not shift time before the cut", () => {
			expect(shiftTimeAfterCut(1, 2, 1)).toBe(1);
		});
		it("snaps time inside the cut to the start of the cut", () => {
			expect(shiftTimeAfterCut(2.5, 2, 1)).toBe(1.5);
		});
		it("shifts time after the cut by the cut duration", () => {
			expect(shiftTimeAfterCut(4, 2, 1)).toBe(3);
		});
	});

	describe("shiftCaptionTimesAfterCut", () => {
		it("shifts regular words and adjusts segment bounds", () => {
			const segments = [
				{
					start: 2,
					end: 4,
					words: [
						{ start: 2, end: 3, deleted: false },
						{ start: 3, end: 4, deleted: false },
					],
				},
			];
			// Cut from 1 to 2 (duration 1). Both words start at >= 2, so they shift by -1.
			shiftCaptionTimesAfterCut(segments, 1, 1);
			expect(segments[0].words?.[0].start).toBe(1);
			expect(segments[0].words?.[0].end).toBe(2);
			expect(segments[0].words?.[1].start).toBe(2);
			expect(segments[0].words?.[1].end).toBe(3);
			expect(segments[0].start).toBe(1);
			expect(segments[0].end).toBe(3);
		});

		it("handles deleted words by keeping their timings if they fall strictly inside the cut", () => {
			const segments = [
				{
					start: 0,
					end: 4,
					words: [
						{ start: 1, end: 2, deleted: true },
						{ start: 2, end: 3, deleted: true },
						{ start: 3, end: 4, deleted: false },
					],
				},
			];
			// Cut from 1 to 3 (duration 2).
			shiftCaptionTimesAfterCut(segments, 1, 2);

			// Word 1: inside cut -> continues without shifting
			expect(segments[0].words?.[0].start).toBe(1);
			expect(segments[0].words?.[0].end).toBe(2);

			// Word 2: inside cut -> continues without shifting
			expect(segments[0].words?.[1].start).toBe(2);
			expect(segments[0].words?.[1].end).toBe(3);

			// Word 3: after cut -> shifts left by 2
			expect(segments[0].words?.[2].start).toBe(1);
			expect(segments[0].words?.[2].end).toBe(2);

			// visible start/end based on undeleted words (Word 3 is the only one)
			expect(segments[0].start).toBe(1);
			expect(segments[0].end).toBe(2);
		});
	});

	describe("shiftTimeAfterInsert", () => {
		it("shifts time after insertion point", () => {
			expect(shiftTimeAfterInsert(3, 2, 1)).toBe(4);
			expect(shiftTimeAfterInsert(1, 2, 1)).toBe(1);
		});
	});

	describe("cleanupDegenerateSegments", () => {
		it("removes zero-duration segments", () => {
			const segments = [
				{ start: 0, end: 1 },
				{ start: 1, end: 1 },
				{ start: 1, end: 2 },
			];
			cleanupDegenerateSegments(segments);
			expect(segments).toEqual([
				{ start: 0, end: 1 },
				{ start: 1, end: 2 },
			]);
		});

		it("removes near-zero segments below epsilon", () => {
			const segments = [
				{ start: 0, end: 1 },
				{ start: 1, end: 1.0005 },
				{ start: 1.0005, end: 2 },
			];
			cleanupDegenerateSegments(segments);
			expect(segments).toEqual([
				{ start: 0, end: 1 },
				{ start: 1.0005, end: 2 },
			]);
		});
	});

	describe("cleanupDegenerateClipSegments", () => {
		it("removes zero-duration clip segments", () => {
			const segments = [
				{ timescale: 1, start: 0, end: 1 },
				{ timescale: 1, start: 1, end: 1 },
				{ timescale: 1, start: 1, end: 2 },
			];
			cleanupDegenerateClipSegments(segments);
			expect(segments).toEqual([
				{ timescale: 1, start: 0, end: 1 },
				{ timescale: 1, start: 1, end: 2 },
			]);
		});

		it("accounts for timescale when checking duration", () => {
			const segments = [
				{ timescale: 2, start: 0, end: 0.001 },
				{ timescale: 1, start: 0, end: 0.002 },
			];
			cleanupDegenerateClipSegments(segments);
			expect(segments).toEqual([{ timescale: 1, start: 0, end: 0.002 }]);
		});
	});

	describe("rippleDeleteFromTrack cleanup", () => {
		it("removes segments that become zero-duration after trimming", () => {
			const segments = [
				{ start: 0, end: 1 },
				{ start: 1, end: 1.5 },
				{ start: 1.5, end: 3 },
			];
			rippleDeleteFromTrack(segments, 1, 1.5);
			const hasDegenerateSegments = segments.some(
				(s) => s.end - s.start < 0.001,
			);
			expect(hasDegenerateSegments).toBe(false);
			expect(segments.length).toBe(2);
		});
	});

	describe("cutClipSegmentsForRange cleanup", () => {
		it("does not leave zero-duration segments after cutting", () => {
			const segments = [
				{ timescale: 1, start: 0, end: 2 },
				{ timescale: 1, start: 2, end: 4 },
			];
			cutClipSegmentsForRange(segments, 1.999, 2.001);
			const hasDegenerateSegments = segments.some(
				(s) => (s.end - s.start) / s.timescale < 0.001,
			);
			expect(hasDegenerateSegments).toBe(false);
		});

		it("handles cutting at exact segment boundaries", () => {
			const segments = [
				{ timescale: 1, start: 0, end: 1 },
				{ timescale: 1, start: 1, end: 2 },
				{ timescale: 1, start: 2, end: 3 },
			];
			cutClipSegmentsForRange(segments, 1, 2);
			const hasDegenerateSegments = segments.some(
				(s) => (s.end - s.start) / s.timescale < 0.001,
			);
			expect(hasDegenerateSegments).toBe(false);
			expect(segments.length).toBe(2);
		});
	});
}
