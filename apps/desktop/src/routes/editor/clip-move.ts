import {
	clipTimelineOffsets,
	getClipTransition,
	rippleTimelineTrack,
	transitionsAfterClipMove,
} from "./clip-transitions";
import type { EditorProjectConfiguration } from "./context";
import { rippleKeyboardTrack } from "./keyboard-timing";
import { scaleKeyframeTimes } from "./three-d";
import { effectiveToOutput, holdWindows } from "./timeline-holds";

/**
 * Moves the clip at `from` so it lands before the clip currently at
 * `insertionIndex` (or at the end when that equals the clip count). Transitions
 * that no longer sit between the same clips are removed and the other tracks
 * close up around them.
 */
export function moveTimelineClip(
	project: EditorProjectConfiguration,
	from: number,
	insertionIndex: number,
) {
	const to = from < insertionIndex ? insertionIndex - 1 : insertionIndex;
	if (from === to) return;
	const timeline = project.timeline;
	if (!timeline) return;
	const proposedSegments = [...timeline.segments];
	const [proposedMoved] = proposedSegments.splice(from, 1);
	proposedSegments.splice(to, 0, proposedMoved);
	const { kept, dropped } = transitionsAfterClipMove(
		timeline.segments.length,
		timeline.transitions ?? [],
		from,
		to,
	);
	dropped.sort((a, b) => b.segmentIndex - a.segmentIndex);

	for (const transition of dropped) {
		const effective = getClipTransition(
			timeline.segments,
			timeline.transitions,
			transition.segmentIndex,
		);
		if (!effective) continue;
		const boundary = effectiveToOutput(
			holdWindows(timeline.textSegments),
			clipTimelineOffsets(timeline.segments, timeline.transitions)[
				transition.segmentIndex
			] + effective.duration,
		);
		timeline.transitions = timeline.transitions.filter(
			(candidate) => candidate.segmentIndex !== transition.segmentIndex,
		);
		const camera3dSegments = timeline.camera3dSegments ?? [];
		const previousCamera3dDurations = camera3dSegments.map(
			(segment) => segment.end - segment.start,
		);
		for (const track of [
			timeline.styleSegments,
			timeline.imageSegments,
			timeline.zoomSegments,
			timeline.sceneSegments ?? [],
			timeline.maskSegments,
			timeline.textSegments,
			timeline.captionSegments ?? [],
			timeline.audioSegments ?? [],
			camera3dSegments,
		]) {
			rippleTimelineTrack(track, boundary, effective.duration);
		}
		rippleKeyboardTrack(
			timeline.keyboardSegments ?? [],
			boundary,
			effective.duration,
		);
		for (let index = 0; index < camera3dSegments.length; index++) {
			const segment = camera3dSegments[index];
			const previousDuration = previousCamera3dDurations[index];
			const nextDuration = segment.end - segment.start;
			if (previousDuration <= 0 || previousDuration === nextDuration) continue;
			scaleKeyframeTimes(segment.tracks, nextDuration / previousDuration);
		}
	}

	timeline.segments = proposedSegments;
	timeline.transitions = kept;
}
