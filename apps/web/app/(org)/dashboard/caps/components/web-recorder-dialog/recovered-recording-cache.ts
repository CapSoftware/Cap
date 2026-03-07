import {
	type RecoveredRecordingSpool,
	recoverOrphanedRecordingSpools,
} from "./recording-spool";

let recoveredRecordingSpoolsPromise: Promise<RecoveredRecordingSpool[]> | null =
	null;
let recoveredRecordingSpoolsCache: RecoveredRecordingSpool[] | null = null;

export const loadRecoveredRecordingSpools = async () => {
	if (recoveredRecordingSpoolsCache !== null) {
		return recoveredRecordingSpoolsCache;
	}

	if (!recoveredRecordingSpoolsPromise) {
		recoveredRecordingSpoolsPromise = recoverOrphanedRecordingSpools()
			.then((recovered) => {
				recoveredRecordingSpoolsCache = recovered;
				return recovered;
			})
			.finally(() => {
				recoveredRecordingSpoolsPromise = null;
			});
	}

	return recoveredRecordingSpoolsPromise;
};

export const removeRecoveredRecordingSpoolFromCache = (sessionId: string) => {
	if (recoveredRecordingSpoolsCache === null) {
		return;
	}

	recoveredRecordingSpoolsCache = recoveredRecordingSpoolsCache.filter(
		(spool) => spool.sessionId !== sessionId,
	);
};

export const resetRecoveredRecordingSpoolsCache = () => {
	recoveredRecordingSpoolsPromise = null;
	recoveredRecordingSpoolsCache = null;
};
