import type { LocalRecordingStrategy } from "@cap/recorder-core/local-recording-backup";
import {
	moveRecordingSpoolToInMemoryBackup,
	moveRecordingSpoolToMemoryBackup,
} from "@cap/recorder-core/recording-spool-fallback";
import { describe, expect, it, vi } from "vitest";

const blobToText = async (blob: Blob) =>
	new TextDecoder().decode(await blob.arrayBuffer());

describe("moveRecordingSpoolToInMemoryBackup", () => {
	it("merges recovered chunks with later in-memory chunks without duplicating them", async () => {
		let retainedChunks = [new Blob(["older"], { type: "video/webm" })];
		let releaseRecovery = null as (() => void) | null;

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

describe("moveRecordingSpoolToMemoryBackup", () => {
	const capped: LocalRecordingStrategy = { mode: "capped", maxBytes: 16 };

	const run = async (options: {
		spoolBytes: number;
		recover: () => Promise<Blob | null>;
		retained?: Blob[];
		alreadyOverflowed?: boolean;
	}) => {
		const replaced: Array<{ chunks: Blob[]; alreadyOverflowed: boolean }> = [];
		const result = await moveRecordingSpoolToMemoryBackup({
			spool: { recoverBlob: options.recover, totalBytes: options.spoolBytes },
			strategy: capped,
			setLocalRecordingStrategy: () => {},
			getRetainedChunks: () => options.retained ?? [],
			getLocalRecordingOverflowed: () => options.alreadyOverflowed ?? false,
			replaceLocalRecording: (chunks, _strategy, alreadyOverflowed) => {
				replaced.push({ chunks, alreadyOverflowed });
				return (
					alreadyOverflowed ||
					chunks.reduce((total, chunk) => total + chunk.size, 0) > 16
				);
			},
		});
		return { ...result, replaced };
	};

	it("moves a spool that fits into memory ahead of the newer chunks", async () => {
		const { recovered, overflowed, replaced } = await run({
			spoolBytes: 9,
			recover: async () => new Blob(["persisted"]),
			retained: [new Blob(["later"])],
		});

		expect(recovered).toBe(true);
		expect(overflowed).toBe(false);
		expect(await blobToText(new Blob(replaced[0]?.chunks))).toBe(
			"persistedlater",
		);
	});

	it("reports an overflow without reading a spool larger than the cap", async () => {
		let read = false;
		const { recovered, overflowed, replaced } = await run({
			spoolBytes: 64,
			recover: async () => {
				read = true;
				return new Blob(["x"]);
			},
			retained: [new Blob(["later"])],
		});

		expect(read).toBe(false);
		expect(recovered).toBe(true);
		expect(overflowed).toBe(true);
		expect(replaced[0]).toEqual({ chunks: [], alreadyOverflowed: true });
	});

	it("keeps the spool when it can't be read back", async () => {
		const { recovered, overflowed } = await run({
			spoolBytes: 4,
			recover: async () => {
				throw new Error("read failed");
			},
		});

		expect(recovered).toBe(false);
		expect(overflowed).toBe(true);
	});

	it("stays overflowed when memory already overflowed", async () => {
		const { overflowed, replaced } = await run({
			spoolBytes: 4,
			recover: async () => new Blob(["data"]),
			retained: [new Blob(["later"])],
			alreadyOverflowed: true,
		});

		expect(overflowed).toBe(true);
		expect(replaced[0]?.chunks).toEqual([]);
	});
});
