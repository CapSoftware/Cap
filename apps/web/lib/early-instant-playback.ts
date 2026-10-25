export function isEarlyInstantPlaybackEnabled(ownerId: string): boolean {
	const setting = process.env.CAP_EARLY_INSTANT_PLAYBACK?.trim();
	if (!setting) return false;
	if (setting === "enabled") return true;
	return setting
		.split(",")
		.map((id) => id.trim())
		.includes(ownerId);
}
