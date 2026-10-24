/**
 * Whether a stopped instant recording may start playing from its first
 * segment while its last segments are still uploading.
 * `CAP_EARLY_INSTANT_PLAYBACK` is "enabled" for everyone, or a comma-separated
 * list of owner user ids to roll it out to; anything else leaves it off.
 */
export function isEarlyInstantPlaybackEnabled(ownerId: string): boolean {
	const setting = process.env.CAP_EARLY_INSTANT_PLAYBACK?.trim();
	if (!setting) return false;
	if (setting === "enabled") return true;
	return setting
		.split(",")
		.map((id) => id.trim())
		.includes(ownerId);
}
