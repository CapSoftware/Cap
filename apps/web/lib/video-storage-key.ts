export function isVideoStorageKey(
	video: { id: string; ownerId: string },
	key: string,
) {
	return (
		key.startsWith(`${video.ownerId}/${video.id}/`) &&
		!key.includes("\\") &&
		key
			.split("/")
			.every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}
