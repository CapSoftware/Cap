import { describe, expect, it, vi } from "vitest";
import { moveRecordingSpoolToInMemoryBackup } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-spool-fallback";

const blobToText = async (blob: Blob) =>
	new TextDecoder().decode(await blob.arrayBuffer());

describe("moveRecordingSpoolToInMemoryBackup", () => {
	it("merges recovered chunks with later in-memory chunks without duplicating them", async () => {
		let retainedChunks = [new Blob(["older"], { type: "video/webm" })];
		let releaseRecovery: (() => void) | null = null;

		const replaceLocalRecording = vi.fn((chunks: Blob[]) => {
			retainedChunks = chunks;
		});

		const transitionPromise = moveRecordingSpoolToInMemoryBackup({
			spool: {
				recoverBlob: () =>
					new Promise<Blob>((resolve) => {
						releaseRecovery = () =>
							resolve(new Blob(["persisted"], { type: "video/webm" }));
					}),
			},
			setLocalRecordingStrategy: () => {
				retainedChunks = [];
			},
			getRetainedChunks: () => [...retainedChunks],
			replaceLocalRecording,
		});

		retainedChunks = [
			...retainedChunks,
			new Blob(["later"], { type: "video/webm" }),
		];

		releaseRecovery?.();
		await transitionPromise;

		expect(replaceLocalRecording).toHaveBeenCalledTimes(1);
		expect(retainedChunks).toHaveLength(2);
		expect(await blobToText(new Blob(retainedChunks))).toBe("persistedlater");
	});
});
