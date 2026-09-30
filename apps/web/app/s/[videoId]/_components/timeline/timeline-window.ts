/**
 * The zoom window: the slice of the video the band is currently drawing.
 *
 * Pure on purpose — no React, no DOM — so the "time under the cursor stays
 * under the cursor" invariant can be unit tested without a renderer.
 */

/** Narrowest the window can get, in seconds (or the whole video if shorter). */
export const MIN_WINDOW_S = 10;

export interface TimelineWindow {
	start: number;
	end: number;
}

const isDuration = (value: number): boolean =>
	Number.isFinite(value) && value > 0;

export const fullWindow = (duration: number): TimelineWindow => ({
	start: 0,
	end: isDuration(duration) ? duration : 0,
});

export const minWindowSpan = (duration: number): number =>
	isDuration(duration) ? Math.min(MIN_WINDOW_S, duration) : 0;

/** Force a window inside `[0, duration]` without letting it collapse. */
export const clampWindow = (
	window: TimelineWindow,
	duration: number,
): TimelineWindow => {
	if (!isDuration(duration)) return { start: 0, end: 0 };

	const requested = window.end - window.start;
	const span = Number.isFinite(requested)
		? Math.min(duration, Math.max(minWindowSpan(duration), requested))
		: duration;

	const start = Number.isFinite(window.start)
		? Math.min(Math.max(window.start, 0), duration - span)
		: 0;

	return { start, end: start + span };
};

export const isFullWindow = (
	window: TimelineWindow,
	duration: number,
): boolean => {
	if (!isDuration(duration)) return true;
	return window.end - window.start >= duration - 0.001;
};

/**
 * Zoom around a point in time. `factor` above 1 zooms in (the span shrinks);
 * `focusT` keeps its position within the window, so the frame under the
 * pointer does not slide away while the wheel turns.
 */
export const zoomWindowAt = (
	window: TimelineWindow,
	factor: number,
	focusT: number,
	duration: number,
): TimelineWindow => {
	if (!isDuration(duration)) return { start: 0, end: 0 };
	if (!Number.isFinite(factor) || factor <= 0)
		return clampWindow(window, duration);

	const current = clampWindow(window, duration);
	const span = current.end - current.start;
	if (span <= 0) return current;

	const focus = Math.min(Math.max(focusT, 0), duration);
	const anchor = Math.min(Math.max((focus - current.start) / span, 0), 1);
	const nextSpan = Math.min(
		duration,
		Math.max(minWindowSpan(duration), span / factor),
	);
	const start = focus - anchor * nextSpan;

	return clampWindow({ start, end: start + nextSpan }, duration);
};

export const panWindowBy = (
	window: TimelineWindow,
	deltaSeconds: number,
	duration: number,
): TimelineWindow => {
	if (!Number.isFinite(deltaSeconds)) return clampWindow(window, duration);
	const current = clampWindow(window, duration);
	return clampWindow(
		{ start: current.start + deltaSeconds, end: current.end + deltaSeconds },
		duration,
	);
};

/** Where the playhead sits inside the window once it has been followed. */
export const FOLLOW_ANCHOR = 0.2;

/**
 * Window that puts `time` at `FOLLOW_ANCHOR` of the span, or null when the
 * playhead is already inside the window (or the whole video is on screen).
 */
export const followWindow = (
	window: TimelineWindow,
	time: number,
	duration: number,
): TimelineWindow | null => {
	if (!isDuration(duration)) return null;
	const current = clampWindow(window, duration);
	if (isFullWindow(current, duration)) return null;
	if (time >= current.start && time <= current.end) return null;

	const span = current.end - current.start;
	const start = time - span * FOLLOW_ANCHOR;
	const next = clampWindow({ start, end: start + span }, duration);
	if (Math.abs(next.start - current.start) < 0.001) return null;
	return next;
};
