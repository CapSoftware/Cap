export type PlayheadMotion = {
	from: number;
	to: number;
	steps: number;
	durationMs: number;
};

/// The playhead's move from `x` towards `limit` during playback, in whole
/// device pixels, for the compositor to run instead of restyling every frame.
export function playheadMotion(
	x: number,
	limit: number,
	secsPerPixel: number,
	dpr: number,
): PlayheadMotion | null {
	if (!(secsPerPixel > 0) || !(dpr > 0) || !Number.isFinite(x)) return null;
	const steps = Math.floor((limit - x) * dpr + 1e-6);
	if (!(steps >= 1)) return null;
	const to = x + steps / dpr;
	return { from: x, to, steps, durationMs: (to - x) * secsPerPixel * 1000 };
}

/// Where the motion has put the playhead `elapsedMs` after it started, as
/// `steps(n, end)` easing places it.
export function playheadMotionX(
	motion: PlayheadMotion,
	elapsedMs: number,
	dpr: number,
) {
	const progress = Math.min(Math.max(elapsedMs / motion.durationMs, 0), 1);
	return motion.from + Math.floor(progress * motion.steps + 1e-9) / dpr;
}

/// How far into the motion to start so each step lands where the playhead's
/// device-pixel rounding would put it: `motion.from` is `trueX` rounded.
export function playheadMotionOffsetMs(
	motion: PlayheadMotion,
	trueX: number,
	dpr: number,
) {
	const stepMs = motion.durationMs / motion.steps;
	const offset =
		(trueX - motion.from + 0.5 / dpr) *
		(motion.durationMs / (motion.to - motion.from));
	return Number.isFinite(offset) ? Math.min(Math.max(offset, 0), stepMs) : 0;
}
