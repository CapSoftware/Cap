import { PART_RANGES } from "./recovery";

export type ChunkPlanInput = {
	totalFrames: number;
	fps: number;
	/** Render slots currently live in the fleet. */
	slots: number;
	/** Frames of roughly `chunkWorkSeconds` of render work on one slot. */
	targetFrames: number;
	minChunkFrames: number;
	/** Pin the chunk count (profiling). */
	chunks?: number;
	chunksPerSlot?: number;
	maxChunks?: number;
	/** Split this many frames off the front as their own chunk (0 = off). */
	leadInFrames: number;
};

/**
 * Chunk boundaries [0, ..., totalFrames]. Short exports get one wave of
 * chunks across every slot; longer ones whole waves of work-sized chunks
 * (36 chunks on 30 slots would leave 24 slots idle in a second wave).
 * Boundaries sit on GOP edges when chunks are long enough, else on whole
 * seconds; every chunk opens with its own IDR either way.
 */
/** Part numbers an export's chunks share: S3's 10,000 less the header's part 1 and a spare. */
const UPLOAD_PARTS = 9998;
/** Part size is planned over all but two of a range's parts (see planJob). */
export const MIN_RANGE_PARTS = 3;

/**
 * How an export's part numbers divide between its chunks: each chunk's block
 * opens with one part the coordinator fills from the chunk's stash (see
 * stitch.ts), followed by `PART_RANGES` dispatch ranges of `partLimit` parts.
 */
export function chunkPartLayout(chunkCount: number) {
	const partsPerChunk = Math.floor(UPLOAD_PARTS / Math.max(1, chunkCount));
	return {
		partsPerChunk,
		partLimit: Math.floor((partsPerChunk - 1) / PART_RANGES),
	};
}

/**
 * Most chunks the planner makes before the lead-in split, which can add one:
 * every count up to `MAX_CHUNKS + 1` leaves each range `MIN_RANGE_PARTS`.
 */
export const MAX_CHUNKS =
	Math.floor(UPLOAD_PARTS / (PART_RANGES * MIN_RANGE_PARTS + 1)) - 1;

export function planChunkBoundaries(input: ChunkPlanInput) {
	const { totalFrames, fps } = input;
	const gop = fps * 2;
	const slots = Math.max(1, input.slots);
	let chunkCount: number;
	if (input.chunks) chunkCount = input.chunks;
	else if (totalFrames / input.targetFrames <= slots) {
		chunkCount = Math.min(
			slots,
			Math.floor(totalFrames / input.minChunkFrames),
		);
	} else {
		const waves = Math.min(
			input.chunksPerSlot ?? 6,
			Math.ceil(totalFrames / input.targetFrames / slots),
		);
		chunkCount = Math.min(slots * waves, MAX_CHUNKS);
	}
	const unit = totalFrames / Math.max(1, chunkCount) >= gop ? gop : fps;
	const units = Math.ceil(totalFrames / unit);
	chunkCount = Math.max(
		1,
		Math.min(
			chunkCount,
			MAX_CHUNKS,
			units,
			input.maxChunks ?? Number.POSITIVE_INFINITY,
		),
	);
	const boundaries: number[] = [];
	for (let index = 0; index <= chunkCount; index++) {
		boundaries.push(
			index === chunkCount
				? totalFrames
				: Math.min(
						totalFrames,
						Math.round((index * units) / chunkCount) * unit,
					),
		);
	}
	// With HLS the first segment waits for chunk 0's sources to download and
	// its first GOP to render. A full-size chunk 0 on a 2 h export meant
	// fetching ~80 s of source first; a short lead-in keeps time to first
	// play independent of export length.
	const leadIn = Math.round(input.leadInFrames / gop) * gop;
	if (leadIn > 0 && (boundaries[1] ?? 0) >= leadIn * 2) {
		boundaries.splice(1, 0, leadIn);
	}
	return boundaries;
}
