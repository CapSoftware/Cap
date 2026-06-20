// Live timers (recording bars) count up from 0:00 and truncate so the
// display never runs ahead of the actual elapsed time.
export const formatDuration = (durationMs: number) => {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

// Finished recordings round to the nearest second and never show 0:00 — a
// sub-second capture still represents real data.
export const formatRecordedDuration = (durationMs: number) => {
	const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};
