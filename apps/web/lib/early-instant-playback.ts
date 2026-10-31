export function isEarlyInstantPlaybackEnabled(): boolean {
	return process.env.CAP_EARLY_INSTANT_PLAYBACK?.trim() !== "disabled";
}
