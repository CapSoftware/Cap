import { useCallback, useEffect, useRef, useState } from "react";

export const useRecordingTimer = () => {
	const [durationMs, setDurationMs] = useState(0);
	const timerRef = useRef<number | null>(null);
	const startTimeRef = useRef<number | null>(null);
	const pauseStartRef = useRef<number | null>(null);
	const pausedDurationRef = useRef(0);

	const clearTimer = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearInterval(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	useEffect(() => {
		return () => {
			clearTimer();
		};
	}, [clearTimer]);

	const commitPausedDuration = useCallback((timestamp?: number) => {
		if (pauseStartRef.current === null) return;
		const now = timestamp ?? performance.now();
		pausedDurationRef.current += now - pauseStartRef.current;
		pauseStartRef.current = null;
	}, []);

	const elapsedAt = useCallback((now: number) => {
		const startTime = startTimeRef.current;
		if (startTime === null) return 0;
		const pausedPending =
			pauseStartRef.current !== null ? now - pauseStartRef.current : 0;
		const totalPaused = pausedDurationRef.current + pausedPending;
		return Math.max(0, now - startTime - totalPaused);
	}, []);

	const syncDurationFromClock = useCallback(
		(timestamp?: number) => {
			const elapsed = elapsedAt(timestamp ?? performance.now());
			setDurationMs(elapsed);
			return elapsed;
		},
		[elapsedAt],
	);

	const startTimer = useCallback(() => {
		const now = performance.now();
		startTimeRef.current = now;
		pauseStartRef.current = null;
		pausedDurationRef.current = 0;
		setDurationMs(0);

		if (timerRef.current !== null) {
			window.clearInterval(timerRef.current);
			timerRef.current = null;
		}

		// The clock shows whole seconds, so the recorder only re-renders when
		// the second changes.
		timerRef.current = window.setInterval(() => {
			if (startTimeRef.current === null) return;
			const elapsed = elapsedAt(performance.now());
			setDurationMs((shown) =>
				Math.floor(shown / 1000) === Math.floor(elapsed / 1000)
					? shown
					: elapsed,
			);
		}, 250);
	}, [elapsedAt]);

	const resetTimer = useCallback(() => {
		clearTimer();
		startTimeRef.current = null;
		pauseStartRef.current = null;
		pausedDurationRef.current = 0;
		setDurationMs(0);
	}, [clearTimer]);

	const pauseTimer = useCallback(
		(timestamp?: number) => {
			const now = timestamp ?? performance.now();
			pauseStartRef.current = now;
			syncDurationFromClock(now);
		},
		[syncDurationFromClock],
	);

	const resumeTimer = useCallback(
		(timestamp?: number) => {
			const now = timestamp ?? performance.now();
			commitPausedDuration(now);
			syncDurationFromClock(now);
		},
		[commitPausedDuration, syncDurationFromClock],
	);

	return {
		durationMs,
		clearTimer,
		startTimer,
		resetTimer,
		pauseTimer,
		resumeTimer,
		commitPausedDuration,
		syncDurationFromClock,
	};
};
