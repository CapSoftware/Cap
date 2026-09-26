import type { SegmentReport } from "./protocol";

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

/**
 * Every dispatch of a chunk writes its own segment objects (named by the
 * dispatch's first upload part), so a hedge or retry finishing late never
 * replaces bytes a playlist already lists.
 */
export function segmentKey(
	prefix: string,
	chunk: number,
	firstPart: number,
	index: number,
) {
	return `${prefix}/c${chunk}-p${firstPart}-${index}.m4s`;
}

/**
 * A worker's segment report, accepted only for objects its own dispatch of
 * this chunk wrote: the coordinator presigns report keys into the playlist.
 */
export function checkSegmentReport(
	report: unknown,
	prefix: string,
	chunk: {
		index: number;
		frames: [number, number];
		firstPart: number;
		partLimit: number;
		dispatches: number;
	},
): SegmentReport | null {
	if (!report || typeof report !== "object") return null;
	const { index, frames, key, last, extradata } = report as Record<
		string,
		unknown
	>;
	if (
		(report as { chunk?: unknown }).chunk !== chunk.index ||
		typeof index !== "number" ||
		!Number.isInteger(index) ||
		index < 0 ||
		typeof last !== "boolean" ||
		typeof extradata !== "string" ||
		extradata.length > 4096 ||
		!Array.isArray(frames) ||
		frames.length !== 2 ||
		!frames.every(Number.isInteger) ||
		frames[0] < chunk.frames[0] ||
		frames[0] >= frames[1] ||
		frames[1] > chunk.frames[1] ||
		typeof key !== "string"
	) {
		return null;
	}
	for (let range = 0; range < Math.max(chunk.dispatches, 1); range++) {
		const firstPart = chunk.firstPart + range * chunk.partLimit;
		if (key === segmentKey(prefix, chunk.index, firstPart, index)) {
			return report as SegmentReport;
		}
	}
	return null;
}
