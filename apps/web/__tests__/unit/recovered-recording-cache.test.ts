import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/recorder-core/recording-spool", () => ({
	RECORDING_SPOOL_LIVE_MIN_IDLE_MS: 3 * 60 * 1000,
	recoverOrphanedRecordingSpools: vi.fn(),
}));

describe("recovered recording cache", () => {
	afterEach(async () => {
		const { resetRecoveredRecordingSpoolsCache } = await import(
			"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache"
		);
		resetRecoveredRecordingSpoolsCache();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("keeps undismissed recovered recordings available across repeated loads", async () => {
		const recoverOrphanedRecordingSpools = vi.mocked(
			(await import("@cap/recorder-core/recording-spool"))
				.recoverOrphanedRecordingSpools,
		);
		recoverOrphanedRecordingSpools.mockResolvedValue([
			{
				sessionId: "first",
				mimeType: "video/webm",
				totalBytes: 1,
				chunkCount: 1,
				createdAt: 1,
				updatedAt: 2,
				blob: new Blob(["a"], { type: "video/webm" }),
			},
			{
				sessionId: "second",
				mimeType: "video/webm",
				totalBytes: 1,
				chunkCount: 1,
				createdAt: 3,
				updatedAt: 4,
				blob: new Blob(["b"], { type: "video/webm" }),
			},
		]);

		const {
			loadRecoveredRecordingSpools,
			removeRecoveredRecordingSpoolFromCache,
		} = await import(
			"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache"
		);

		const firstLoad = await loadRecoveredRecordingSpools();
		expect(firstLoad.map((spool) => spool.sessionId)).toEqual([
			"first",
			"second",
		]);

		removeRecoveredRecordingSpoolFromCache("first");

		const secondLoad = await loadRecoveredRecordingSpools();
		expect(secondLoad.map((spool) => spool.sessionId)).toEqual(["second"]);
		expect(recoverOrphanedRecordingSpools).toHaveBeenCalledTimes(1);
	});
	it("refreshes an empty result so recordings excluded as live can be recovered later", async () => {
		vi.useFakeTimers();
		const recover = vi.mocked(
			(await import("@cap/recorder-core/recording-spool"))
				.recoverOrphanedRecordingSpools,
		);
		recover.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				sessionId: "later",
				mimeType: "video/webm",
				totalBytes: 1,
				chunkCount: 1,
				createdAt: 1,
				updatedAt: 2,
				blob: new Blob(["a"]),
			},
		]);
		const { loadRecoveredRecordingSpools } = await import(
			"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache"
		);
		expect(await loadRecoveredRecordingSpools()).toEqual([]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(
			(await loadRecoveredRecordingSpools()).map((spool) => spool.sessionId),
		).toEqual(["later"]);
		expect(recover).toHaveBeenCalledTimes(2);
	});
});
