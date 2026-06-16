export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.2, 1.5, 1.75, 2] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const DEFAULT_PLAYBACK_SPEED = 1.2;

export function isPlaybackSpeed(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizePlaybackSpeed(value: unknown): number {
	if (!isPlaybackSpeed(value)) return DEFAULT_PLAYBACK_SPEED;

	let closest: number = PLAYBACK_SPEEDS[0];
	let smallestDelta = Math.abs(value - closest);
	for (const speed of PLAYBACK_SPEEDS) {
		const delta = Math.abs(value - speed);
		if (delta < smallestDelta) {
			smallestDelta = delta;
			closest = speed;
		}
	}
	return closest;
}

export function resolveDefaultPlaybackSpeed(
	videoSpeed?: number | null,
	orgSpeed?: number | null,
): number {
	if (isPlaybackSpeed(videoSpeed)) return normalizePlaybackSpeed(videoSpeed);
	if (isPlaybackSpeed(orgSpeed)) return normalizePlaybackSpeed(orgSpeed);
	return DEFAULT_PLAYBACK_SPEED;
}

export function formatPlaybackDuration(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0s";

	const rounded = Math.round(totalSeconds);
	const hours = Math.floor(rounded / 3600);
	const minutes = Math.floor((rounded % 3600) / 60);
	const seconds = rounded % 60;

	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0)
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}
