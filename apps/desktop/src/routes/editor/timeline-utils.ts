import type { KeyboardTrackSegment } from "~/utils/tauri";
import {
	type ClipTransition,
	clipDuration,
	clipTimelineDuration,
	clipTimelineOffsets,
	getClipTransition,
	transitionsAfterClipDelete,
	transitionsAfterClipSplit,
} from "./clip-transitions";
import { rippleDeleteKeyboardTrack } from "./keyboard-timing";
import {
	CAMERA3D_TRACK_KEYS,
	type Camera3DTracks,
	sampleTrack,
} from "./three-d";
import {
	effectiveToOutput,
	effectiveToOutputEnd,
	type HoldSourceSegment,
	holdWindows,
} from "./timeline-holds";

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
			seg.start = cutEnd - shiftDuration;
			seg.end = Math.max(seg.start, seg.end - shiftDuration);
		}
	}
}

type RippleMaskSegment = {
	start: number;
	end: number;
	keyframes?: {
		position?: Array<{ time: number }>;
		size?: Array<{ time: number }>;
		intensity?: Array<{ time: number }>;
	};
};

function rippleDeleteMaskTrack(
	segments: RippleMaskSegment[],
	cutStart: number,
	cutEnd: number,
	shift: number,
) {
	const previousStarts = new Map(
		segments.map((segment) => [segment, segment.start]),
	);
	rippleDeleteFromTrack(segments, cutStart, cutEnd, shift);
	for (const segment of segments) {
		const oldStart = previousStarts.get(segment);
		if (oldStart === undefined || !segment.keyframes) continue;
		const duration = segment.end - segment.start;
		const rebase = <T extends { time: number }>(keyframes: T[] | undefined) =>
			keyframes?.flatMap((keyframe) => {
				const absolute = oldStart + keyframe.time;
				if (absolute >= cutStart && absolute < cutEnd) return [];
				const mapped = absolute >= cutEnd ? absolute - shift : absolute;
				const time = mapped - segment.start;
				return time >= 0 && time <= duration ? [{ ...keyframe, time }] : [];
			});
		segment.keyframes.position = rebase(segment.keyframes.position);
		segment.keyframes.size = rebase(segment.keyframes.size);
		segment.keyframes.intensity = rebase(segment.keyframes.intensity);
	}
}

type RippleAudioSegment = {
	start: number;
	end: number;
	trimStart?: number;
	fadeIn?: number;
};

function rippleDeleteAudioTrack(
	segments: RippleAudioSegment[],
	cutStart: number,
	cutEnd: number,
	shift: number,
) {
	for (const segment of segments) {
		if (
			segment.start >= cutStart &&
			segment.start < cutEnd &&
			segment.end > cutEnd &&
			segment.trimStart !== undefined
		) {
			segment.trimStart += cutEnd - segment.start;
			if (segment.fadeIn !== undefined) segment.fadeIn = 0;
		}
	}
	rippleDeleteFromTrack(segments, cutStart, cutEnd, shift);
}

type RippleCamera3DSegment = {
	start: number;
	end: number;
	tracks: Camera3DTracks;
	transitionIn?: number;
	transitionOut?: number;
};

function rippleDeleteCamera3DTrack(
	segments: RippleCamera3DSegment[],
	cutStart: number,
	cutEnd: number,
	shift: number,
) {
	for (
		let segmentIndex = segments.length - 1;
		segmentIndex >= 0;
		segmentIndex--
	) {
		const segment = segments[segmentIndex];
		if (segment.end <= cutStart) continue;
		if (segment.start >= cutEnd) {
			segment.start -= shift;
			segment.end -= shift;
			continue;
		}
		if (segment.start >= cutStart && segment.end <= cutEnd) {
			segments.splice(segmentIndex, 1);
			continue;
		}

		const oldStart = segment.start;
		const oldEnd = segment.end;
		const keepsLeft = oldStart < cutStart;
		const keepsRight = oldEnd > cutEnd;
		const newStart = keepsLeft ? oldStart : cutEnd - shift;
		const newEnd = keepsRight ? oldEnd - shift : cutStart;
		const leftCutTime = cutStart - oldStart;
		const rightCutTime = cutEnd - oldStart;

		for (const trackKey of CAMERA3D_TRACK_KEYS) {
			const keyframes = segment.tracks[trackKey];
			if (keyframes.length === 0) continue;
			const before = keepsLeft
				? keyframes
						.filter((keyframe) => keyframe.time < leftCutTime)
						.map((keyframe) => ({ ...keyframe }))
				: [];
			const after = keepsRight
				? keyframes
						.filter((keyframe) => keyframe.time > rightCutTime)
						.map((keyframe) => ({
							...keyframe,
							time: oldStart + keyframe.time - shift - newStart,
						}))
				: [];
			const nextKeyframe = keyframes.find(
				(keyframe) => keyframe.time >= leftCutTime,
			);
			const previousKeyframe = [...keyframes]
				.reverse()
				.find((keyframe) => keyframe.time <= rightCutTime);
			segment.tracks[trackKey] = [
				...before,
				...(keepsLeft
					? [
							{
								time: cutStart - newStart,
								value: sampleTrack(0, keyframes, leftCutTime),
								outEasing: null,
								inEasing: nextKeyframe?.inEasing ?? null,
							},
						]
					: []),
				...(keepsRight
					? [
							{
								time: cutEnd - shift - newStart,
								value: sampleTrack(0, keyframes, rightCutTime),
								outEasing: previousKeyframe?.outEasing ?? null,
								inEasing: null,
							},
						]
					: []),
				...after,
			];
		}

		segment.start = newStart;
		segment.end = Math.max(newStart, newEnd);
		if (keepsLeft && !keepsRight && segment.transitionOut !== undefined) {
			segment.transitionOut = 0;
		}
		if (!keepsLeft && keepsRight && segment.transitionIn !== undefined) {
			segment.transitionIn = 0;
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

		if (segments.length === 1 && newSegs.length === 0) return transitions;
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
		styleSegments?: Array<{ start: number; end: number }> | null;
		imageSegments?: Array<{ start: number; end: number }> | null;
		zoomSegments?: Array<{ start: number; end: number }> | null;
		sceneSegments?: Array<{ start: number; end: number }> | null;
		maskSegments?: RippleMaskSegment[] | null;
		textSegments?: Array<HoldSourceSegment> | null;
		captionSegments?: Array<{ start: number; end: number }> | null;
		keyboardSegments?: KeyboardTrackSegment[] | null;
		audioSegments?: RippleAudioSegment[] | null;
		camera3dSegments?: RippleCamera3DSegment[] | null;
	},
	cutStart: number,
	cutEnd: number,
	requestedSegmentIndex?: number,
	trackCutRange?: {
		start: number;
		end: number;
		removeHoldAtStart?: boolean;
	},
) {
	// The clip cut below works in the gapless recording-flow domain, but the
	// overlay tracks live in output time, which includes fullscreen-text
	// holds. Convert the cut range before touching them, and let the held
	// time inside the cut leave with the text segments it belongs to (they
	// sit inside the converted range, so the overlay pass deletes them).
	const holds = holdWindows(timeline.textSegments);
	const trackCutStart = trackCutRange?.start ?? cutStart;
	const trackCutEnd = trackCutRange?.end ?? cutEnd;
	const overlayCutStart = trackCutRange?.removeHoldAtStart
		? effectiveToOutputEnd(holds, trackCutStart)
		: effectiveToOutput(holds, trackCutStart);
	const overlayCutEnd = effectiveToOutputEnd(holds, trackCutEnd);

	const durationBefore = clipTimelineDuration(
		timeline.segments,
		timeline.transitions ?? [],
	);
	const previousSegments = timeline.segments.map((segment) => ({ ...segment }));
	const previousTransitions = (timeline.transitions ?? []).map(
		(transition) => ({
			...transition,
		}),
	);
	const nextTransitions = cutClipSegmentsForRange(
		timeline.segments,
		timeline.transitions ?? [],
		cutStart,
		cutEnd,
		requestedSegmentIndex,
	);
	timeline.transitions = nextTransitions;
	const clipChanged =
		previousSegments.length !== timeline.segments.length ||
		previousSegments.some((segment, index) => {
			const current = timeline.segments[index];
			return (
				!current ||
				segment.start !== current.start ||
				segment.end !== current.end ||
				segment.timescale !== current.timescale
			);
		}) ||
		previousTransitions.length !== nextTransitions.length ||
		previousTransitions.some((transition, index) => {
			const current = nextTransitions[index];
			return (
				!current ||
				transition.segmentIndex !== current.segmentIndex ||
				transition.type !== current.type ||
				transition.duration !== current.duration
			);
		});
	if (!clipChanged) return;
	const shiftDuration = Math.max(
		0,
		durationBefore - clipTimelineDuration(timeline.segments, nextTransitions),
	);
	const overlayShift =
		shiftDuration +
		(overlayCutEnd - overlayCutStart - (trackCutEnd - trackCutStart));
	for (const track of [timeline.styleSegments, timeline.imageSegments]) {
		if (track)
			rippleDeleteFromTrack(
				track,
				overlayCutStart,
				overlayCutEnd,
				overlayShift,
			);
	}
	if (timeline.zoomSegments)
		rippleDeleteFromTrack(
			timeline.zoomSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	if (timeline.sceneSegments)
		rippleDeleteFromTrack(
			timeline.sceneSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	if (timeline.maskSegments)
		rippleDeleteMaskTrack(
			timeline.maskSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	if (timeline.textSegments)
		rippleDeleteFromTrack(
			timeline.textSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	if (timeline.captionSegments)
		rippleDeleteFromTrack(
			timeline.captionSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	if (timeline.keyboardSegments)
		rippleDeleteKeyboardTrack(
			timeline.keyboardSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	if (timeline.audioSegments)
		rippleDeleteAudioTrack(
			timeline.audioSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	if (timeline.camera3dSegments) {
		rippleDeleteCamera3DTrack(
			timeline.camera3dSegments,
			overlayCutStart,
			overlayCutEnd,
			overlayShift,
		);
	}
}

export function deleteClipAndRippleAllTracks(
	timeline: Parameters<typeof rippleDeleteAllTracks>[0],
	segmentIndex: number,
) {
	const segment = timeline.segments[segmentIndex];
	if (!segment || timeline.segments.length < 2) return false;
	const start = clipTimelineOffsets(
		timeline.segments,
		timeline.transitions ?? [],
	)[segmentIndex];
	const incomingDuration =
		getClipTransition(
			timeline.segments,
			timeline.transitions ?? [],
			segmentIndex,
		)?.duration ?? 0;
	const outgoingDuration =
		getClipTransition(
			timeline.segments,
			timeline.transitions ?? [],
			segmentIndex + 1,
		)?.duration ?? 0;
	const end = start + clipDuration(segment);
	rippleDeleteAllTracks(timeline, start, end, segmentIndex, {
		start: start + incomingDuration,
		end: end - outgoingDuration,
		removeHoldAtStart: true,
	});
	return true;
}

if (import.meta.vitest) {
	const { expect, it } = import.meta.vitest;

	it("ripple-deletes overlay tracks in hold-extended output time", () => {
		// Fullscreen text at output [2,4] pauses the recording for 2s, so
		// gapless recording time g >= 2 plays at output g + 2.
		const timeline = {
			segments: [{ start: 0, end: 10, timescale: 1 }],
			transitions: [] as ClipTransition[],
			textSegments: [
				{ start: 2, end: 4, enabled: true, layout: "fullscreen" as const },
			],
			// Covers recording content 3.5..4.5 — entirely before the cut.
			zoomSegments: [{ start: 5.5, end: 6.5 }],
			// Covers recording content 6..7 — entirely after the cut.
			keyboardSegments: [
				{
					id: "keyboard-1",
					start: 8,
					end: 9,
					displayText: "a",
					keys: [{ key: "a", timeOffset: 0 }],
				},
			],
		};

		// Delete recording content [5,6], which plays at output [7,8].
		rippleDeleteAllTracks(timeline, 5, 6);

		expect(timeline.segments).toEqual([
			{ start: 0, end: 5, timescale: 1 },
			{ start: 6, end: 10, timescale: 1 },
		]);
		// Before the fix the gapless cut range [5,6] was compared against
		// these output-time positions and mangled the zoom to [5,5.5].
		expect(timeline.zoomSegments).toEqual([{ start: 5.5, end: 6.5 }]);
		expect(timeline.keyboardSegments).toEqual([
			{
				id: "keyboard-1",
				start: 7,
				end: 8,
				displayText: "a",
				keys: [{ key: "a", timeOffset: 0 }],
			},
		]);
		expect(timeline.textSegments).toHaveLength(1);
	});

	it("deletes a hold inside the cut together with its inserted time", () => {
		const timeline = {
			segments: [{ start: 0, end: 10, timescale: 1 }],
			transitions: [] as ClipTransition[],
			textSegments: [
				{ start: 2, end: 4, enabled: true, layout: "fullscreen" as const },
			],
			// Covers recording content 6..7, at output [8,9].
			zoomSegments: [{ start: 8, end: 9 }],
		};

		// Delete recording content [1,5]: output [1,7], swallowing the hold.
		rippleDeleteAllTracks(timeline, 1, 5);

		expect(timeline.segments).toEqual([
			{ start: 0, end: 1, timescale: 1 },
			{ start: 5, end: 10, timescale: 1 },
		]);
		// The fullscreen text sat inside the cut and leaves with it.
		expect(timeline.textSegments).toEqual([]);
		// 4s of recording plus the 2s hold left the output timeline, and no
		// holds remain, so output equals gapless again.
		expect(timeline.zoomSegments).toEqual([{ start: 2, end: 3 }]);
	});

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
