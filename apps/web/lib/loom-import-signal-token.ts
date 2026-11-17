export const LOOM_IMPORT_SIGNAL_PREFIX = "loom-import:";

export function getLoomImportSignalToken(videoId: string, attemptId: string) {
	return `${LOOM_IMPORT_SIGNAL_PREFIX}${videoId}:${attemptId}`;
}

export function isLoomImportSignalToken(token: string, videoId: string) {
	return token.startsWith(`${LOOM_IMPORT_SIGNAL_PREFIX}${videoId}:`);
}
