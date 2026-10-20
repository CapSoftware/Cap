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
