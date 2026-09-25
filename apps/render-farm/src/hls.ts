/**
 * Whether a segment that started at frame `start` closes at the GOP boundary
 * `boundary`. Workers apply this as each GOP finishes encoding; a restarted
 * coordinator re-derives the same cuts from a chunk's keyframes to rebuild the
 * playlist, so both must use this one rule.
 */
export function closesSegment(
	start: number,
	boundary: number,
	segmentFrames: number,
) {
	return boundary - start >= segmentFrames;
}

/** Chunk-local [start, end) frame ranges of a chunk's HLS segments. */
export function segmentCuts(
	keyframes: readonly number[],
	total: number,
	segmentFrames: number,
) {
	const cuts: [number, number][] = [];
	let start = 0;
	for (const key of [...keyframes].sort((a, b) => a - b)) {
		if (key > 0 && key < total && closesSegment(start, key, segmentFrames)) {
			cuts.push([start, key]);
			start = key;
		}
	}
	cuts.push([start, total]);
	return cuts;
}
