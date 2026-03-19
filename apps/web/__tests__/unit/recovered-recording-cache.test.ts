import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-spool",
	() => ({
		recoverOrphanedRecordingSpools: vi.fn(),
	}),
);

describe("recovered recording cache", () => {
	afterEach(async () => {
		const { resetRecoveredRecordingSpoolsCache } = await import(
			"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache"
		);
		resetRecoveredRecordingSpoolsCache();
		vi.clearAllMocks();
	});

	it("keeps undismissed recovered recordings available across repeated loads", async () => {
		const recoverOrphanedRecordingSpools = vi.mocked(
			(
				await import(
					"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-spool"
				)
			).recoverOrphanedRecordingSpools,
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
});
