import { createSignal } from "solid-js";
import { clipDuration, clipTimelineOffsets } from "../clip-transitions";
import type { TimelineTrackType } from "../context";
import { effectiveToOutput, holdWindows } from "../timeline-holds";

export const SEGMENT_SNAP_PX = 8;
const SNAPPING_STORAGE_KEY = "cap.timeline.snapping";

type Span = { start: number; end: number };

export type SnapTimeline = {
	segments: Array<{ start: number; end: number; timescale: number }>;
	transitions?: Parameters<typeof clipTimelineOffsets>[1] | null;
	textSegments?: Parameters<typeof holdWindows>[0];
	zoomSegments?: Span[] | null;
	sceneSegments?: Span[] | null;
	maskSegments?: Span[] | null;
	captionSegments?: Span[] | null;
	keyboardSegments?: Span[] | null;
	audioSegments?: Span[] | null;
	styleSegments?: Span[] | null;
	imageSegments?: Span[] | null;
	camera3dSegments?: Span[] | null;
};

export type SnapExclusion = { type: TimelineTrackType; index: number };

const readSnappingPreference = () => {
	try {
		return localStorage.getItem(SNAPPING_STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
};

const [snappingEnabled, setSnappingEnabledSignal] = createSignal(
	readSnappingPreference(),
);
const [snapGuideTime, setSnapGuideTime] = createSignal<number | null>(null);

export { snapGuideTime, snappingEnabled };

export function toggleSnapping() {
	const next = !snappingEnabled();
	setSnappingEnabledSignal(next);
	try {
		localStorage.setItem(SNAPPING_STORAGE_KEY, next ? "on" : "off");
	} catch {}
}

export function clearSnapGuide() {
	setSnapGuideTime(null);
}

export function timelineSnapTargets(
	timeline: SnapTimeline | null | undefined,
	playhead: number | null,
	exclude?: SnapExclusion,
): number[] {
	const targets: number[] = [];
	if (playhead !== null && Number.isFinite(playhead)) targets.push(playhead);
	if (!timeline) return targets;

	const holds = holdWindows(timeline.textSegments);
	const offsets = clipTimelineOffsets(
		timeline.segments,
		timeline.transitions ?? [],
	);
	timeline.segments.forEach((segment, index) => {
		targets.push(effectiveToOutput(holds, offsets[index]));
		targets.push(
			effectiveToOutput(holds, offsets[index] + clipDuration(segment)),
		);
	});

	const tracks: Array<[TimelineTrackType, Span[] | null | undefined]> = [
		["zoom", timeline.zoomSegments],
		["scene", timeline.sceneSegments],
		["mask", timeline.maskSegments],
		["text", timeline.textSegments as Span[] | undefined],
		["caption", timeline.captionSegments],
		["keyboard", timeline.keyboardSegments],
		["audio", timeline.audioSegments],
		["style", timeline.styleSegments],
		["image", timeline.imageSegments],
		["3d", timeline.camera3dSegments],
	];
	for (const [type, spans] of tracks) {
		spans?.forEach((span, index) => {
			if (exclude && exclude.type === type && exclude.index === index) return;
			targets.push(span.start, span.end);
		});
	}
	return targets;
}

function nearestTarget(time: number, targets: number[], threshold: number) {
	let best: number | null = null;
	let bestDistance = threshold;
	for (const target of targets) {
		const distance = Math.abs(target - time);
		if (distance <= bestDistance) {
			best = target;
			bestDistance = distance;
		}
	}
	return best === null ? null : { target: best, distance: bestDistance };
}

const snappingActive = (event: MouseEvent) =>
	snappingEnabled() && !event.altKey;

export function snapEdgeTime(
	time: number,
	event: MouseEvent,
	targets: number[],
	secsPerPixel: number,
): number {
	if (!snappingActive(event)) {
		setSnapGuideTime(null);
		return time;
	}
	const hit = nearestTarget(time, targets, SEGMENT_SNAP_PX * secsPerPixel);
	setSnapGuideTime(hit?.target ?? null);
	return hit?.target ?? time;
}

export function snapMoveDelta(
	span: Span,
	delta: number,
	event: MouseEvent,
	targets: number[],
	secsPerPixel: number,
): number {
	if (!snappingActive(event)) {
		setSnapGuideTime(null);
		return delta;
	}
	const threshold = SEGMENT_SNAP_PX * secsPerPixel;
	const startHit = nearestTarget(span.start + delta, targets, threshold);
	const endHit = nearestTarget(span.end + delta, targets, threshold);
	const useStart =
		startHit && (!endHit || startHit.distance <= endHit.distance);
	if (useStart) {
		setSnapGuideTime(startHit.target);
		return startHit.target - span.start;
	}
	if (endHit) {
		setSnapGuideTime(endHit.target);
		return endHit.target - span.end;
	}
	setSnapGuideTime(null);
	return delta;
}

if (import.meta.vitest) {
	const { expect, it } = import.meta.vitest;
	const event = { altKey: false } as MouseEvent;

	it("snaps edges to clip cuts and ignores the dragged segment", () => {
		const targets = timelineSnapTargets(
			{
				segments: [
					{ start: 0, end: 10, timescale: 1 },
					{ start: 20, end: 25, timescale: 1 },
				],
				sceneSegments: [{ start: 3, end: 7 }],
			},
			null,
			{ type: "scene", index: 0 },
		);
		expect(targets).toContain(10);
		expect(targets).not.toContain(3);
		expect(snapEdgeTime(10.05, event, targets, 0.01)).toBe(10);
		expect(snapEdgeTime(11, event, targets, 0.01)).toBe(11);
		expect(
			snapEdgeTime(10.05, { altKey: true } as MouseEvent, targets, 0.01),
		).toBe(10.05);
	});

	it("moves a segment so its nearest edge lands on the target", () => {
		const delta = snapMoveDelta({ start: 3, end: 7 }, 2.96, event, [10], 0.01);
		expect(delta).toBeCloseTo(3);
	});
}
