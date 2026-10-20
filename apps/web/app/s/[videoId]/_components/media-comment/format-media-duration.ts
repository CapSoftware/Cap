/**
 * `m:ss` clock for media-comment durations, widening to `h:mm:ss` past an hour.
 *
 * Seconds are floored so a 9.7s note reads "0:09" for its whole life instead of
 * flicking to "0:10" a frame before it ends. Non-finite/negative input (an
 * element with no metadata yet) collapses to "0:00".
 */
export function formatMediaDuration(
	seconds: number | null | undefined,
): string {
	const value =
		typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
			? Math.floor(seconds)
			: 0;

	const secs = value % 60;
	const mins = Math.floor(value / 60) % 60;
	const hours = Math.floor(value / 3600);
	const pad = (part: number) => part.toString().padStart(2, "0");

	return hours > 0
		? `${hours}:${pad(mins)}:${pad(secs)}`
		: `${mins}:${pad(secs)}`;
}
