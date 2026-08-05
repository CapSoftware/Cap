/**
 * Pure geometry/sampling math for the timeline filmstrip. Kept
 * framework-free so the capture hook stays thin and this part stays unit-testable.
 */

/** Bounds on how many tiles the strip renders, regardless of width. */
export const FILMSTRIP_MIN_TILES = 6;
export const FILMSTRIP_MAX_TILES = 28;

/** Ideal tile width in px; the count is derived from it, then clamped. */
export const FILMSTRIP_TARGET_TILE_W = 104;

/**
 * HLS sources pay for every sample with a segment fetch, so they get fewer
 * capture points than tiles; tiles in between borrow the nearest frame.
 */
export const FILMSTRIP_MAX_HLS_SAMPLES = 10;

/** Frames one video keeps around before the oldest capture is dropped. */
export const FRAME_POOL_MAX = 240;

/** Bounds on the pool's time grid, in seconds. */
export const POOL_QUANTUM_MIN = 0.5;
export const POOL_QUANTUM_MAX = 30;

/** How many tiles fit a strip of the given usable width. */
export const filmstripTileCount = (usableWidth: number): number => {
	if (!Number.isFinite(usableWidth) || usableWidth <= 0) return 0;
	return Math.max(
		FILMSTRIP_MIN_TILES,
		Math.min(
			FILMSTRIP_MAX_TILES,
			Math.round(usableWidth / FILMSTRIP_TARGET_TILE_W),
		),
	);
};

/**
 * Spacing of the pool's time grid. Frames are captured onto it and shared by
 * every zoom level, so zooming borrows what is already there instead of
 * throwing the strip away and recapturing it.
 */
export const filmstripPoolQuantum = (duration: number): number => {
	if (!Number.isFinite(duration) || duration <= 0) return POOL_QUANTUM_MIN;
	return Math.min(
		POOL_QUANTUM_MAX,
		Math.max(POOL_QUANTUM_MIN, duration / (FILMSTRIP_MAX_TILES * 4)),
	);
};

/** Grid slot a moment belongs to. Rounded, so nearby requests collapse. */
export const quantizePoolTime = (time: number, quantum: number): number => {
	if (!Number.isFinite(time) || !Number.isFinite(quantum) || quantum <= 0)
		return 0;
	return Math.round(Math.max(0, time) / quantum) * quantum;
};

/** One capture point per tile centre inside the window, clamped to the video. */
export const filmstripWindowTimes = (
	count: number,
	start: number,
	end: number,
	duration: number,
): number[] => {
	const span = end - start;
	if (count <= 0 || !Number.isFinite(span) || span <= 0) return [];
	if (!Number.isFinite(duration) || duration <= 0) return [];

	const times: number[] = [];
	for (let index = 0; index < count; index++) {
		const t = start + ((index + 0.5) / count) * span;
		// Stay clear of the very end: the last frames of a stream often seek
		// slowly or land on black.
		times.push(Math.min(Math.max(t, 0), Math.max(0, duration - 0.1)));
	}
	return times;
};

/**
 * Order in which samples are captured: a coarse pass (every 4th), then the
 * halfway points, then the rest, so the strip sketches itself in and sharpens
 * rather than filling left to right.
 */
export const filmstripCaptureOrder = (count: number): number[] => {
	const order: number[] = [];
	const seen = new Set<number>();
	for (const stride of [4, 2, 1]) {
		for (let index = 0; index < count; index += stride) {
			if (seen.has(index)) continue;
			seen.add(index);
			order.push(index);
		}
	}
	return order;
};

/**
 * Nearest pooled moment within `tolerance`, or null. Lets a tile show a
 * stale-but-near frame the instant the window moves, while the exact one is
 * still being captured.
 */
export const nearestPooledTime = (
	pooled: Iterable<number>,
	time: number,
	tolerance: number,
): number | null => {
	let best: number | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of pooled) {
		const distance = Math.abs(candidate - time);
		if (distance > tolerance || distance >= bestDistance) continue;
		best = candidate;
		bestDistance = distance;
	}
	return best;
};

/** How far a tile may reach into the pool before it gives up and shows nothing. */
export const poolBorrowTolerance = (
	quantum: number,
	windowSpan: number,
	tileCount: number,
): number => {
	const perTile = tileCount > 0 ? windowSpan / tileCount : quantum;
	return Math.max(quantum, Number.isFinite(perTile) ? perTile : quantum);
};

/**
 * Insert a frame, dropping the oldest capture once the pool is full. Eviction
 * is insertion-order rather than access-order: borrowing happens inside a
 * render memo, where touching the map would be a side effect.
 */
export const rememberFrame = (
	frames: Map<number, string>,
	time: number,
	dataUrl: string,
	max: number = FRAME_POOL_MAX,
): void => {
	frames.set(time, dataUrl);
	while (frames.size > max) {
		const oldest = frames.keys().next();
		if (oldest.done) break;
		frames.delete(oldest.value);
	}
};
