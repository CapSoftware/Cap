export function isActiveEditorReplacementUpload(
	ownerId: string,
	videoId: string,
	phase: string | null,
	key: string | null,
) {
	if (phase !== "uploading" || !key) return false;
	const prefix = `${ownerId}/${videoId}/.recording/outputs/reupload-`;
	return (
		key.startsWith(prefix) &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/result\.mp4$/.test(
			key.slice(prefix.length),
		)
	);
}

const ABANDONED_REPLACEMENT_UPLOAD_MS = 10 * 60 * 1000;

/**
 * A replacement of the share video that stopped moving, e.g. its tab closed
 * mid-upload. The recording itself is intact, so it no longer blocks editing.
 */
export function isAbandonedEditorReplacementUpload(
	ownerId: string,
	videoId: string,
	phase: string | null,
	key: string | null,
	updatedAt: Date | null,
) {
	return (
		!!updatedAt &&
		Date.now() - updatedAt.getTime() > ABANDONED_REPLACEMENT_UPLOAD_MS &&
		isActiveEditorReplacementUpload(ownerId, videoId, phase, key)
	);
}
