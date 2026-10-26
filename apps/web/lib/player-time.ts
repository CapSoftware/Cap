export function formatPlayerTime(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "00:00";

	const rounded = Math.floor(totalSeconds);
	const hours = Math.floor(rounded / 3600);
	const minutes = Math.floor((rounded % 3600) / 60);
	const seconds = rounded % 60;
	const paddedSeconds = seconds.toString().padStart(2, "0");

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${paddedSeconds}`;
	}

	return `${minutes.toString().padStart(2, "0")}:${paddedSeconds}`;
}

/** `M:SS`, or `H:MM:SS` once the time reaches an hour. */
export function formatClock(seconds: number): string {
	const total =
		Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const secs = total % 60;
	const mins = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(mins)}:${pad(secs)}`
		: `${mins}:${pad(secs)}`;
}

/** `MM:SS.ss`, or `H:MM:SS.ss` once the time reaches an hour. */
export function formatClockWithHundredths(seconds: number): string {
	const safe = Math.max(0, seconds);
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe - hours * 3600) / 60);
	const remainingSeconds = safe - hours * 3600 - minutes * 60;
	const padded = remainingSeconds.toFixed(2).padStart(5, "0");
	const clock = `${String(minutes).padStart(2, "0")}:${padded}`;
	return hours > 0 ? `${hours}:${clock}` : clock;
}
