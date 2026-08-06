import type { TimelineSegment } from "~/utils/tauri";

export const DEFAULT_CLIP_TRANSITION_DURATION = 0.5;
export const MIN_CLIP_TRANSITION_DURATION = 0.05;

export type ClipTransitionKind = "cross-fade" | "fade-through-black";

export type ClipTransition = {
	segmentIndex: number;
	type: ClipTransitionKind;
	duration: number;
};

export type ClipTransitionInput = Omit<ClipTransition, "segmentIndex">;

export function clipDuration(segment: TimelineSegment) {
	return Math.max(0, (segment.end - segment.start) / segment.timescale);
}

export function maxTransitionDuration(
	previous: TimelineSegment | undefined,
	current: TimelineSegment | undefined,
) {
	if (!previous || !current) return 0;
	return Math.min(clipDuration(previous), clipDuration(current)) / 2;
}

export function clampTransitionDuration(
	duration: number,
	previous: TimelineSegment | undefined,
	current: TimelineSegment | undefined,
) {
	const maximum = maxTransitionDuration(previous, current);
	if (maximum < MIN_CLIP_TRANSITION_DURATION) return 0;
	return Math.min(Math.max(duration, MIN_CLIP_TRANSITION_DURATION), maximum);
}

export function getClipTransition(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
	index: number,
): ClipTransition | null {
	if (index <= 0 || index >= segments.length) return null;
	let transition: ClipTransition | undefined;
	for (
		let transitionIndex = transitions.length - 1;
		transitionIndex >= 0;
		transitionIndex--
	) {
		const candidate = transitions[transitionIndex];
		if (candidate.segmentIndex === index) {
			transition = candidate;
			break;
		}
	}
	if (!transition) return null;
	const duration = clampTransitionDuration(
		transition.duration,
		segments[index - 1],
		segments[index],
	);
	if (duration === 0) return null;
	return { ...transition, duration };
}

export function clipTransitionMap(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
) {
	const configured = new Array<ClipTransition | undefined>(segments.length);
	for (const transition of transitions) {
		if (
			transition.segmentIndex > 0 &&
			transition.segmentIndex < segments.length
		) {
			configured[transition.segmentIndex] = transition;
		}
	}

	return configured.map((transition, index): ClipTransition | null => {
		if (!transition) return null;
		const duration = clampTransitionDuration(
			transition.duration,
			segments[index - 1],
			segments[index],
		);
		return duration > 0 ? { ...transition, duration } : null;
	});
}

export function clipTimelineOffsets(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
) {
	const offsets = new Array<number>(segments.length);
	const effectiveTransitions = clipTransitionMap(segments, transitions);
	let offset = 0;

	for (let index = 0; index < segments.length; index++) {
		offset -= effectiveTransitions[index]?.duration ?? 0;
		offsets[index] = offset;
		offset += clipDuration(segments[index]);
	}

	return offsets;
}

export function normalizeClipTransitions(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
) {
	return clipTransitionMap(segments, transitions).filter(
		(transition): transition is ClipTransition => transition !== null,
	);
}

export function clipTimelineDuration(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
) {
	if (segments.length === 0) return 0;
	const offsets = clipTimelineOffsets(segments, transitions);
	return (
		offsets[offsets.length - 1] + clipDuration(segments[segments.length - 1])
	);
}

export function rangeIntersectsClipTransition(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
	start: number,
	end: number,
) {
	const offsets = clipTimelineOffsets(segments, transitions);
	return clipTransitionMap(segments, transitions).some((transition, index) => {
		if (!transition) return false;
		const transitionStart = offsets[index];
		return (
			end > transitionStart && start < transitionStart + transition.duration
		);
	});
}

export function clipCutPreservesTransitionGeometry(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
	segmentIndex: number,
	cutStart: number,
	cutEnd: number,
) {
	const segment = segments[segmentIndex];
	if (!segment) return false;
	const offsets = clipTimelineOffsets(segments, transitions);
	const segmentStart = offsets[segmentIndex];
	const duration = clipDuration(segment);
	const localStart = cutStart - segmentStart;
	const localEnd = cutEnd - segmentStart;
	if (localStart < 0 || localEnd > duration || localStart >= localEnd)
		return false;
	const incomingDuration =
		getClipTransition(segments, transitions, segmentIndex)?.duration ?? 0;
	const outgoingDuration =
		getClipTransition(segments, transitions, segmentIndex + 1)?.duration ?? 0;
	return (
		localStart + Number.EPSILON >= incomingDuration * 2 &&
		duration - localEnd + Number.EPSILON >= outgoingDuration * 2
	);
}

export function rippleTimelineTrack(
	track: { start: number; end: number }[],
	boundary: number,
	shift: number,
) {
	for (const item of track) {
		if (item.start >= boundary) {
			item.start += shift;
			item.end += shift;
		} else if (item.end > boundary) {
			item.end = Math.max(item.start, item.end + shift);
		}
	}
}

export function timelineShiftAfterClipDurationChange(
	time: number,
	oldCurrentStart: number,
	newCurrentStart: number,
	oldStableStart: number,
	oldNextBoundary: number,
	newNextBoundary: number,
) {
	if (time < oldCurrentStart) return 0;
	if (time < oldStableStart) {
		const incomingDuration = oldStableStart - oldCurrentStart;
		if (incomingDuration <= Number.EPSILON) return 0;
		return (
			((newCurrentStart - oldCurrentStart) * (oldStableStart - time)) /
			incomingDuration
		);
	}
	const fullShift = newNextBoundary - oldNextBoundary;
	if (time >= oldNextBoundary) return fullShift;
	if (time <= oldStableStart) return 0;
	const affectedDuration = oldNextBoundary - oldStableStart;
	if (affectedDuration <= Number.EPSILON) return fullShift;
	return (fullShift * (time - oldStableStart)) / affectedDuration;
}

export function transitionsAfterClipSplit(
	transitions: ClipTransition[],
	segmentIndex: number,
) {
	return transitions.map((transition) =>
		transition.segmentIndex > segmentIndex
			? { ...transition, segmentIndex: transition.segmentIndex + 1 }
			: transition,
	);
}

export function transitionsAfterClipDelete(
	transitions: ClipTransition[],
	segmentIndex: number,
) {
	return transitions.flatMap((transition) => {
		if (
			transition.segmentIndex === segmentIndex ||
			transition.segmentIndex === segmentIndex + 1
		)
			return [];
		return [
			transition.segmentIndex > segmentIndex
				? { ...transition, segmentIndex: transition.segmentIndex - 1 }
				: transition,
		];
	});
}

export function transitionsAfterClipMove(
	segmentCount: number,
	transitions: ClipTransition[],
	from: number,
	to: number,
) {
	const order = Array.from({ length: segmentCount }, (_, index) => index);
	const [moved] = order.splice(from, 1);
	order.splice(to, 0, moved);
	const kept: ClipTransition[] = [];
	const dropped: ClipTransition[] = [];

	for (const transition of transitions) {
		const originalIndex = transition.segmentIndex;
		const nextIndex = order.findIndex(
			(segmentIndex, index) =>
				index > 0 &&
				order[index - 1] === originalIndex - 1 &&
				segmentIndex === originalIndex,
		);
		if (nextIndex > 0) {
			kept.push({ ...transition, segmentIndex: nextIndex });
		} else {
			dropped.push(transition);
		}
	}

	kept.sort((a, b) => a.segmentIndex - b.segmentIndex);
	return { kept, dropped };
}
