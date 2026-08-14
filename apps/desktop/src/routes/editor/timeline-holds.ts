import type { TextSegment } from "./text";

// Mirrors TimelineConfiguration::hold_windows and friends in
// crates/project/src/configuration.rs — fullscreen text segments pause the
// recording clock, inserting their duration into the output timeline. The
// frontend needs the same arithmetic for the ruler, playhead clamps, clip
// positions and output<->recording conversions.

export type HoldWindow = [number, number];

export function holdWindows(
	textSegments: readonly TextSegment[] | null | undefined,
): HoldWindow[] {
	if (!textSegments?.length) return [];
	const windows = textSegments
		.filter(
			(segment) =>
				segment.enabled !== false &&
				segment.layout === "fullscreen" &&
				segment.end > segment.start,
		)
		.map((segment): HoldWindow => [segment.start, segment.end])
		.sort((a, b) => a[0] - b[0]);
	const merged: HoldWindow[] = [];
	for (const window of windows) {
		const last = merged[merged.length - 1];
		if (last && window[0] <= last[1]) {
			last[1] = Math.max(last[1], window[1]);
		} else {
			merged.push([window[0], window[1]]);
		}
	}
	return merged;
}

export function totalHeldDuration(holds: HoldWindow[]): number {
	return holds.reduce((sum, [start, end]) => sum + (end - start), 0);
}

export function heldTimeBefore(holds: HoldWindow[], time: number): number {
	return holds.reduce(
		(sum, [start, end]) => sum + Math.max(0, Math.min(time, end) - start),
		0,
	);
}

// Places a gapless (recording-flow) timestamp back into output time, landing
// after every hold it passed.
export function effectiveToOutput(
	holds: HoldWindow[],
	effective: number,
): number {
	let output = effective;
	for (const [start, end] of holds) {
		if (output >= start) output += end - start;
		else break;
	}
	return output;
}

// effectiveToOutput for range *end* timestamps: an end landing exactly on a
// hold boundary binds to the content before the pause instead of jumping past
// it, so a range that finishes right where a hold begins doesn't stretch
// across the inserted time.
export function effectiveToOutputEnd(
	holds: HoldWindow[],
	effective: number,
): number {
	let output = effective;
	for (const [start, end] of holds) {
		if (output > start) output += end - start;
		else break;
	}
	return output;
}
