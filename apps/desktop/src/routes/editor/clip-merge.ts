import type { TimelineSegment } from "~/utils/tauri";
import type { ClipTransition } from "./clip-transitions";

export type ClipMergeDirection = "previous" | "next";

export type ClipMergeBlocker = "edge" | "different-recording" | "gap" | "speed";

const CONTIGUOUS_EPSILON = 1e-6;

export function clipMergeKeptIndex(
	index: number,
	direction: ClipMergeDirection,
) {
	return direction === "next" ? index : index - 1;
}

export function clipMergeBlocker(
	segments: ReadonlyArray<TimelineSegment>,
	index: number,
	direction: ClipMergeDirection,
): ClipMergeBlocker | null {
	const kept = clipMergeKeptIndex(index, direction);
	const left = segments[kept];
	const right = segments[kept + 1];
	if (!left || !right) return "edge";
	if ((left.recordingSegment ?? 0) !== (right.recordingSegment ?? 0))
		return "different-recording";
	if (Math.abs(left.end - right.start) > CONTIGUOUS_EPSILON) return "gap";
	if (left.timescale !== right.timescale) return "speed";
	return null;
}

export function clipMergeBlockerHint(blocker: ClipMergeBlocker): string {
	switch (blocker) {
		case "edge":
			return "No clip on that side";
		case "different-recording":
			return "Different recording";
		case "gap":
			return "Footage was cut between them";
		case "speed":
			return "Match the clip speeds first";
	}
}

/**
 * The clip that replaces `left` and `right`: it spans both, and takes its
 * settings (speed audio mode, volume, cursor visibility) from `settingsFrom`,
 * the clip the user acted on. A custom name survives from whichever clip has
 * one, preferring the acted-on clip.
 */
export function mergedClipSegment<T extends TimelineSegment>(
	left: T,
	right: T,
	settingsFrom: T,
): T {
	const name =
		settingsFrom.name?.trim() ||
		left.name?.trim() ||
		right.name?.trim() ||
		null;
	return {
		...settingsFrom,
		recordingSegment: left.recordingSegment,
		timescale: left.timescale,
		start: left.start,
		end: right.end,
		name,
	};
}

/**
 * The boundary between `keptIndex` and the clip after it disappears, so any
 * transition on it goes and every later transition shifts down one.
 */
export function transitionsAfterClipMerge(
	transitions: ClipTransition[],
	keptIndex: number,
) {
	return transitions.flatMap((transition) => {
		if (transition.segmentIndex === keptIndex + 1) return [];
		return [
			transition.segmentIndex > keptIndex + 1
				? { ...transition, segmentIndex: transition.segmentIndex - 1 }
				: transition,
		];
	});
}

if (import.meta.vitest) {
	const { describe, expect, it } = import.meta.vitest;

	const clip = (
		start: number,
		end: number,
		extra: Partial<TimelineSegment> = {},
	): TimelineSegment => ({
		recordingSegment: 0,
		timescale: 1,
		start,
		end,
		...extra,
	});

	describe("clipMergeBlocker", () => {
		it("allows contiguous clips from the same recording at the same speed", () => {
			const segments = [clip(0, 4), clip(4, 8)];
			expect(clipMergeBlocker(segments, 0, "next")).toBeNull();
			expect(clipMergeBlocker(segments, 1, "previous")).toBeNull();
		});

		it("refuses the timeline edges", () => {
			const segments = [clip(0, 4), clip(4, 8)];
			expect(clipMergeBlocker(segments, 0, "previous")).toBe("edge");
			expect(clipMergeBlocker(segments, 1, "next")).toBe("edge");
		});

		it("refuses clips whose footage was cut apart, or that differ in source or speed", () => {
			expect(clipMergeBlocker([clip(0, 4), clip(5, 8)], 0, "next")).toBe("gap");
			expect(
				clipMergeBlocker(
					[clip(0, 4), clip(4, 8, { recordingSegment: 1 })],
					0,
					"next",
				),
			).toBe("different-recording");
			expect(
				clipMergeBlocker([clip(0, 4), clip(4, 8, { timescale: 2 })], 0, "next"),
			).toBe("speed");
		});
	});

	describe("mergedClipSegment", () => {
		it("spans both clips and keeps the acted-on clip's settings", () => {
			const left = clip(0, 4, { volume: 0.5, name: "Intro" });
			const right = clip(4, 8, { speedAudioMode: "mute", hideCursor: true });
			expect(mergedClipSegment(left, right, right)).toEqual({
				recordingSegment: 0,
				timescale: 1,
				start: 0,
				end: 8,
				speedAudioMode: "mute",
				hideCursor: true,
				name: "Intro",
			});
			expect(mergedClipSegment(left, right, left)).toMatchObject({
				start: 0,
				end: 8,
				volume: 0.5,
				name: "Intro",
			});
		});
	});

	describe("transitionsAfterClipMerge", () => {
		it("drops the merged boundary's transition and reindexes the rest", () => {
			const transitions: ClipTransition[] = [
				{ segmentIndex: 1, type: "cross-fade", duration: 0.5 },
				{ segmentIndex: 2, type: "cross-fade", duration: 0.5 },
				{ segmentIndex: 3, type: "fade-through-black", duration: 0.25 },
			];
			expect(transitionsAfterClipMerge(transitions, 1)).toEqual([
				{ segmentIndex: 1, type: "cross-fade", duration: 0.5 },
				{ segmentIndex: 2, type: "fade-through-black", duration: 0.25 },
			]);
		});
	});
}
