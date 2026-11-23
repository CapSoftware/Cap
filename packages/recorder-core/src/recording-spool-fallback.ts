import type { LocalRecordingStrategy } from "./local-recording-backup";
import type { RecordingSpool } from "./recording-spool";

export const moveRecordingSpoolToInMemoryBackup = async ({
	spool,
	setLocalRecordingStrategy,
	getRetainedChunks,
	replaceLocalRecording,
}: {
	spool: Pick<RecordingSpool, "recoverBlob">;
	setLocalRecordingStrategy: (strategy: { mode: "full" }) => void;
	getRetainedChunks: () => Blob[];
	replaceLocalRecording: (chunks: Blob[], strategy: { mode: "full" }) => void;
}) => {
	setLocalRecordingStrategy({ mode: "full" });

	let recoveredBlob: Blob | null = null;
	let recovered = true;
	try {
		recoveredBlob = await spool.recoverBlob();
	} catch (error) {
		recovered = false;
		console.error("Failed to recover persisted recording chunk data", error);
	}

	const retainedChunks = getRetainedChunks();
	replaceLocalRecording(
		recoveredBlob ? [recoveredBlob, ...retainedChunks] : retainedChunks,
		{ mode: "full" },
	);
	return recovered;
};

// `recovered` is false when the spool could not be read back. The spool then
// holds the only copy of the recording's start, so callers must keep it.
export const moveRecordingSpoolToMemoryBackup = async ({
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
