"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clamp, DEMO_DURATION } from "./scene";

/**
 * A playhead without a video behind it.
 *
 * The fictional recording is 2:48, which nobody is going to sit through inside a
 * blog post, so demos run the clock fast by default — long enough to watch the
 * playhead cross a comment, short enough that a full pass is a few seconds.
 */
export function useDemoClock({
	initial = 0,
	rate = 6,
}: {
	initial?: number;
	rate?: number;
} = {}) {
	const [time, setTime] = useState(initial);
	const [playing, setPlaying] = useState(false);
	const timeRef = useRef(initial);

	const seek = useCallback((next: number) => {
		const value = clamp(next, 0, DEMO_DURATION);
		timeRef.current = value;
		setTime(value);
	}, []);

	useEffect(() => {
		if (!playing) return;
		if (timeRef.current >= DEMO_DURATION) seek(0);

		let frame = 0;
		let last = performance.now();

		const tick = (now: number) => {
			const delta = (now - last) / 1000;
			last = now;
			const next = timeRef.current + delta * rate;
			if (next >= DEMO_DURATION) {
				seek(DEMO_DURATION);
				setPlaying(false);
				return;
			}
			seek(next);
			frame = requestAnimationFrame(tick);
		};

		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing, rate, seek]);

	const toggle = useCallback(() => setPlaying((value) => !value), []);
	const pause = useCallback(() => setPlaying(false), []);

	return { time, seek, playing, toggle, pause };
}
