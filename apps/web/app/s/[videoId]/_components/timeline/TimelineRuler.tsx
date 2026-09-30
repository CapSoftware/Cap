"use client";

import { memo, useMemo } from "react";
import { fractionInWindow, railLeft } from "./timeline-constants";

/** Tick intervals, coarsest last. The first one under the cap wins. */
const TICK_STEPS = [1, 5, 15, 30, 60, 300, 600, 1800, 3600];
const MAX_TICKS = 12;

const pickStep = (span: number): number => {
	for (const step of TICK_STEPS) {
		if (span / step <= MAX_TICKS) return step;
	}
	return TICK_STEPS[TICK_STEPS.length - 1] as number;
};

interface TimelineRulerProps {
	windowStart: number;
	windowEnd: number;
}

/**
 * The anchor line: a hairline across the top of the comments surface with
 * interval ticks on it, so branch stems have something to hang from and the
 * strip above reads as a timeline rather than a bare bar.
 *
 * Unlabelled by design — the transport clock is the deck's only time readout.
 * Memoised on the window alone: the ruler has no idea the video is playing and
 * must never learn.
 */
export const TimelineRuler = memo(function TimelineRuler({
	windowStart,
	windowEnd,
}: TimelineRulerProps) {
	const ticks = useMemo(() => {
		const span = windowEnd - windowStart;
		if (!Number.isFinite(span) || span <= 0) return [];
		const step = pickStep(span);
		const marks: { t: number; left: string }[] = [];
		const first = Math.ceil(windowStart / step) * step;
		for (let t = first; t < windowEnd; t += step) {
			if (t <= 0) continue;
			marks.push({
				t,
				left: railLeft(fractionInWindow(t, windowStart, windowEnd) * 100),
			});
		}
		return marks;
	}, [windowStart, windowEnd]);

	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 top-0 h-2"
		>
			<span className="absolute inset-x-0 top-0 h-px bg-gray-5" />
			{ticks.map((tick) => (
				<span
					key={tick.t}
					className="absolute top-0 h-1.5 w-px -translate-x-1/2 bg-gray-6"
					style={{ left: tick.left }}
				/>
			))}
		</div>
	);
});
