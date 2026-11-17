export const LOOM_REASSIGN_CLAIM_TTL_MS = 60 * 60 * 1000;

export function getOwnerOriginalKey(
	key: unknown,
	ownerId: string,
	videoId: string,
) {
	if (typeof key !== "string") return null;
	const [, keyVideoId, ...rest] = key.split("/");
	const fileName = rest.join("/");
	if (keyVideoId !== videoId || !fileName) return null;
	return `${ownerId}/${videoId}/${fileName}`;
}
