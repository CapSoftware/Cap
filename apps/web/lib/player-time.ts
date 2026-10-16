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
