/** `M:SS`, or `H:MM:SS` once the video is an hour or longer. */
export const formatClock = (seconds: number): string => {
	const total =
		Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const secs = total % 60;
	const mins = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(mins)}:${pad(secs)}`
		: `${mins}:${pad(secs)}`;
};
