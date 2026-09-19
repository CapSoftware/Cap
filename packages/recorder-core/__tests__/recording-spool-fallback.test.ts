import { moveRecordingSpoolToInMemoryBackup } from "@cap/recorder-core/recording-spool-fallback";
import { describe, expect, it, vi } from "vitest";

const blobToText = async (blob: Blob) =>
	new TextDecoder().decode(await blob.arrayBuffer());

describe("moveRecordingSpoolToInMemoryBackup", () => {
	it("merges recovered chunks with later in-memory chunks without duplicating them", async () => {
		let retainedChunks = [new Blob(["older"], { type: "video/webm" })];
		let releaseRecovery = null as (() => void) | null;

		const replaceLocalRecording = vi.fn((chunks: Blob[]) => {
			retainedChunks = chunks;
			return false;
		});

		const transitionPromise = moveRecordingSpoolToInMemoryBackup({
			spool: {
				totalBytes: 9,
				recoverBlob: () =>
					new Promise<Blob>((resolve) => {
						releaseRecovery = () =>
							resolve(new Blob(["persisted"], { type: "video/webm" }));
					}),
			},
			strategy: { mode: "full" },
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

	it("skips a large persisted backup before it can be reconstructed in memory", async () => {
		const recoverBlob = vi.fn(async () => new Blob(["large"]));
		const replaceLocalRecording = vi.fn(() => true);
		const strategy = { mode: "capped" as const, maxBytes: 10 };

		const overflowed = await moveRecordingSpoolToInMemoryBackup({
			spool: { totalBytes: 11, recoverBlob },
			strategy,
			setLocalRecordingStrategy: vi.fn(),
			getRetainedChunks: () => [],
			replaceLocalRecording,
		});

		expect(overflowed).toBe(true);
		expect(recoverBlob).not.toHaveBeenCalled();
		expect(replaceLocalRecording).toHaveBeenCalledWith([], strategy, true);
	});
});
