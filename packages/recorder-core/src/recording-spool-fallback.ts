import type { LocalRecordingStrategy } from "./local-recording-backup";
import type { RecordingSpool } from "./recording-spool";

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
	let alreadyOverflowed =
		strategy.mode === "capped" && spool.totalBytes > strategy.maxBytes;
	if (!alreadyOverflowed) {
		try {
			recoveredBlob = await spool.recoverBlob();
		} catch (error) {
			alreadyOverflowed = true;
			console.error("Failed to recover persisted recording chunk data", error);
		}
	}

	alreadyOverflowed ||= getLocalRecordingOverflowed();
	const retainedChunks = alreadyOverflowed ? [] : getRetainedChunks();
	return replaceLocalRecording(
		alreadyOverflowed
			? []
			: recoveredBlob
				? [recoveredBlob, ...retainedChunks]
				: retainedChunks,
		strategy,
		alreadyOverflowed,
	);
};
