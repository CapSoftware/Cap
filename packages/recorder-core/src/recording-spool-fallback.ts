import type { LocalRecordingStrategy } from "./local-recording-backup";
import type { RecordingSpool } from "./recording-spool";

/**
 * `recovered` is false when the spool's data could not be read back: the
 * spool then still holds the only complete copy of the recording's start, so
 * callers must keep it rather than dispose it.
 */
export const moveRecordingSpoolToInMemoryBackup = async ({
	spool,
	strategy,
	setLocalRecordingStrategy,
	getRetainedChunks,
	getLocalRecordingOverflowed,
	replaceLocalRecording,
}: {
	spool: Pick<RecordingSpool, "recoverBlob" | "totalBytes">;
	strategy: LocalRecordingStrategy;
	setLocalRecordingStrategy: (strategy: LocalRecordingStrategy) => void;
	getRetainedChunks: () => Blob[];
	getLocalRecordingOverflowed: () => boolean;
	replaceLocalRecording: (
		chunks: Blob[],
		strategy: LocalRecordingStrategy,
		alreadyOverflowed: boolean,
	) => boolean;
}) => {
	setLocalRecordingStrategy(strategy);

	let recoveredBlob: Blob | null = null;
	let recovered = true;
	let alreadyOverflowed =
		strategy.mode === "capped" && spool.totalBytes > strategy.maxBytes;
	if (!alreadyOverflowed) {
		try {
			recoveredBlob = await spool.recoverBlob();
		} catch (error) {
			recovered = false;
			alreadyOverflowed = true;
			console.error("Failed to recover persisted recording chunk data", error);
		}
	}

	alreadyOverflowed ||= getLocalRecordingOverflowed();
	const retainedChunks = alreadyOverflowed ? [] : getRetainedChunks();
	const overflowed = replaceLocalRecording(
		alreadyOverflowed
			? []
			: recoveredBlob
				? [recoveredBlob, ...retainedChunks]
				: retainedChunks,
		strategy,
		alreadyOverflowed,
	);
	return { recovered, overflowed };
};
