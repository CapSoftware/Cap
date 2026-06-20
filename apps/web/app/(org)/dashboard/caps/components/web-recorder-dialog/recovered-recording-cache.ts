import {
	RECORDING_SPOOL_LIVE_MIN_IDLE_MS,
	type RecoveredRecordingSpool,
	recoverOrphanedRecordingSpools,
} from "@cap/recorder-core/recording-spool";

let recoveredRecordingSpoolsPromise: Promise<RecoveredRecordingSpool[]> | null =
	null;
let recoveredRecordingSpoolsCache: RecoveredRecordingSpool[] | null = null;

export const loadRecoveredRecordingSpools = async () => {
	if (recoveredRecordingSpoolsCache !== null) {
		return recoveredRecordingSpoolsCache;
	}

	if (!recoveredRecordingSpoolsPromise) {
		// A spool updated within the live window may belong to a recording that
		// is live (possibly paused) in another dashboard tab; live recorders
		// heartbeat via RecordingSpool.touch(), so it must not be surfaced as
		// recoverable — dismissing or downloading it would delete the live
		// session's crash backup.
		recoveredRecordingSpoolsPromise = recoverOrphanedRecordingSpools(
			undefined,
			{ minIdleMs: RECORDING_SPOOL_LIVE_MIN_IDLE_MS },
		)
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
