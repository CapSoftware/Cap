export function getEditSourceKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/source/original.mp4`;
}

export function isEditSourceObjectKey(key: string) {
	return key.split("/")[2] === "source";
}

export function isEditSourceKey({
	ownerId,
	videoId,
	rawFileKey,
}: {
	ownerId: string;
	videoId: string;
	rawFileKey: string | null | undefined;
}) {
	return rawFileKey === getEditSourceKey(ownerId, videoId);
}
