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
/** Keeps four part ranges of at least three parts per chunk in one upload. */
export const MAX_CHUNKS = 800;

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
		Math.min(chunkCount, units, input.maxChunks ?? Number.POSITIVE_INFINITY),
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
