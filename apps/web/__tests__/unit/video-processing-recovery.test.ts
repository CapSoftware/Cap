import type { VideoMetadata } from "@cap/database/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();
const mockStart = vi.fn();
const mockSetVideoProcessingError = vi.fn();
const mockIsLoomImportRunning = vi.fn();
const mockStartLoomImportWorkflow = vi.fn();

vi.mock("@cap/database", () => ({
	db: mockDb,
}));

vi.mock("@cap/database/schema", () => ({
	importedVideos: {
		id: "importedVideos.id",
		orgId: "importedVideos.orgId",
		source: "importedVideos.source",
		sourceId: "importedVideos.sourceId",
	},
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		orgId: "videos.orgId",
		bucket: "videos.bucket",
		source: "videos.source",
		metadata: "videos.metadata",
	},
	videoUploads: {
		videoId: "videoUploads.videoId",
		phase: "videoUploads.phase",
		processingError: "videoUploads.processingError",
		processingMessage: "videoUploads.processingMessage",
		rawFileKey: "videoUploads.rawFileKey",
		updatedAt: "videoUploads.updatedAt",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	asc: vi.fn((value: unknown) => value),
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	isNotNull: vi.fn((value: unknown) => value),
	isNull: vi.fn((value: unknown) => value),
	like: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	lte: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	notLike: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	or: vi.fn((...conditions: unknown[]) => conditions),
	sql: vi.fn(),
}));

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/lib/video-processing", () => ({
	setVideoProcessingError: mockSetVideoProcessingError,
}));

vi.mock("@/lib/loom-import-start", () => ({
	isLoomImportRunning: mockIsLoomImportRunning,
	startLoomImportWorkflow: mockStartLoomImportWorkflow,
	LoomImportStartError: class extends Error {
		constructor(
			readonly canRetry: boolean,
			cause: unknown,
		) {
			super("Loom import startup failed", { cause });
		}
	},
}));

vi.mock("@/workflows/process-video", () => ({
	processVideoWorkflow: vi.fn(),
}));

vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));

type Candidate = {
	videoId: string;
	userId: string;
	bucketId: string | null;
	rawFileKey: string | null;
	uploadUpdatedAt: Date;
	metadata?: VideoMetadata;
};

function makeSelectChain(candidates: unknown[]) {
	const chain = {
		select: vi.fn(),
		from: vi.fn(),
		innerJoin: vi.fn(),
		leftJoin: vi.fn(),
		where: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn(),
	};
	chain.select.mockReturnValue(chain);
	chain.from.mockReturnValue(chain);
	chain.innerJoin.mockReturnValue(chain);
	chain.leftJoin.mockReturnValue(chain);
	chain.where.mockReturnValue(chain);
	chain.orderBy.mockReturnValue(chain);
	chain.limit.mockResolvedValue(candidates);
	return chain;
}

function makeUpdateChain(affectedRows: number) {
	const chain = {
		update: vi.fn(),
		set: vi.fn(),
		where: vi.fn(),
	};
	chain.update.mockReturnValue(chain);
	chain.set.mockReturnValue(chain);
	chain.where.mockResolvedValue([{ affectedRows }]);
	return chain;
}

const candidate: Candidate = {
	videoId: "video-1",
	userId: "user-1",
	bucketId: null,
	rawFileKey: "user-1/video-1/raw.mp4",
	uploadUpdatedAt: new Date("2026-10-21T16:00:00Z"),
};

beforeEach(() => {
	vi.resetAllMocks();
	mockStart.mockResolvedValue({ runId: "run-1" });
	mockSetVideoProcessingError.mockResolvedValue(undefined);
	mockIsLoomImportRunning.mockResolvedValue(false);
	mockStartLoomImportWorkflow.mockResolvedValue(undefined);
});

describe("recoverFailedVideoProcessing", () => {
	it("atomically claims and restarts an affected upload", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([candidate]))
			.mockReturnValueOnce(makeUpdateChain(1));
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(result.statuses).toEqual({ started: 1 });
	});

	it("does not start a duplicate workflow when another run owns the claim", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([candidate]))
			.mockReturnValueOnce(makeUpdateChain(0));
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(mockStart).not.toHaveBeenCalled();
		expect(result.statuses).toEqual({ "already-claimed": 1 });
	});

	it("keeps a transient start failure eligible for the next recovery run", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([candidate]))
			.mockReturnValueOnce(makeUpdateChain(1));
		mockStart.mockRejectedValueOnce(new Error("temporary failure"));
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(mockSetVideoProcessingError).toHaveBeenCalledWith(
			"video-1",
			"Processing recovery will retry automatically",
			expect.objectContaining({
				message: expect.stringContaining("temporary failure"),
			}),
		);
		expect(result.statuses).toEqual({ "retry-scheduled": 1 });
	});

	it("restarts a Loom import that exhausted its capacity retries", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(
				makeSelectChain([
					{
						...candidate,
						orgId: "organization-1",
					},
				]),
			)
			.mockReturnValueOnce(makeSelectChain([{ loomVideoId: "loom-video-1" }]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeUpdateChain(1));
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(mockStartLoomImportWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				videoId: "video-1",
				loomVideoId: "loom-video-1",
				rawFileKey: "user-1/video-1/raw.mp4",
				reuseExistingRawUpload: true,
			}),
		);
		expect(result.statuses).toEqual({ started: 1 });
	});

	it("keeps a failed Loom workflow start eligible for Loom-specific recovery", async () => {
		const restore = makeUpdateChain(1);
		mockDb
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(
				makeSelectChain([
					{
						...candidate,
						orgId: "organization-1",
					},
				]),
			)
			.mockReturnValueOnce(makeSelectChain([{ loomVideoId: "loom-video-1" }]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeUpdateChain(1))
			.mockReturnValueOnce(restore);
		const { LoomImportStartError } = await import("@/lib/loom-import-start");
		mockStartLoomImportWorkflow.mockRejectedValueOnce(
			new LoomImportStartError(true, new Error("temporary start failure")),
		);
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(restore.set).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "error",
				processingError: expect.stringContaining("import-loom-video"),
			}),
		);
		expect(result.statuses).toEqual({ "retry-scheduled": 1 });
	});

	it.each(["pending", "accepted", "uncertain"] as const)(
		"preserves a slow source lookup with a protected %s receipt",
		async (dispatch) => {
			const receipt = { runId: "slow-source-run", dispatch };
			mockDb
				.mockReturnValueOnce(
					makeSelectChain([
						{
							...candidate,
							rawFileKey: null,
							loomVideoId: "loom-video-1",
							uploadUpdatedAt: new Date(Date.now() - 16 * 60 * 1000),
							metadata: { loomImportRun: receipt },
						},
					]),
				)
				.mockReturnValueOnce(makeSelectChain([]))
				.mockReturnValueOnce(makeSelectChain([]))
				.mockReturnValueOnce(makeUpdateChain(1));
			mockIsLoomImportRunning.mockResolvedValueOnce(true);
			const { recoverFailedVideoProcessing } = await import(
				"@/lib/video-processing-recovery"
			);

			const result = await recoverFailedVideoProcessing();

			expect(mockStart).not.toHaveBeenCalled();
			expect(mockStartLoomImportWorkflow).not.toHaveBeenCalled();
			expect(result.statuses).toEqual({ "already-claimed": 1 });
			expect(mockDb).toHaveBeenCalledTimes(3);
			expect(mockIsLoomImportRunning).toHaveBeenCalledWith(receipt);
		},
	);

	it("rechecks the selected upload timestamp before a terminal run is recovered", async () => {
		const claim = makeUpdateChain(0);
		const receipt = { runId: "terminal-run", dispatch: "accepted" as const };
		mockDb
			.mockReturnValueOnce(
				makeSelectChain([
					{
						...candidate,
						rawFileKey: null,
						loomVideoId: "loom-video-1",
						metadata: { loomImportRun: receipt },
					},
				]),
			)
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(claim);
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(claim.where).toHaveBeenCalledWith(
			expect.arrayContaining([
				{ left: "videoUploads.updatedAt", right: candidate.uploadUpdatedAt },
			]),
		);
		expect(mockStartLoomImportWorkflow).not.toHaveBeenCalled();
		expect(result.statuses).toEqual({ "already-claimed": 1 });
	});

	it("retains the recovery claim when dispatch acknowledgement is uncertain", async () => {
		mockDb
			.mockReturnValueOnce(
				makeSelectChain([
					{ ...candidate, rawFileKey: null, loomVideoId: "loom-video-1" },
				]),
			)
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeUpdateChain(1));
		const { LoomImportStartError } = await import("@/lib/loom-import-start");
		mockStartLoomImportWorkflow.mockRejectedValueOnce(
			new LoomImportStartError(false, new Error("acknowledgement lost")),
		);
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(mockDb).toHaveBeenCalledTimes(4);
		expect(mockStart).not.toHaveBeenCalled();
		expect(result.statuses).toEqual({ "already-claimed": 1 });
	});

	it("restores only the claimed pending upload after a confirmed queue rejection", async () => {
		const claim = makeUpdateChain(1);
		const restore = makeUpdateChain(1);
		mockDb
			.mockReturnValueOnce(
				makeSelectChain([
					{ ...candidate, rawFileKey: null, loomVideoId: "loom-video-1" },
				]),
			)
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(claim)
			.mockReturnValueOnce(restore);
		const { LoomImportStartError } = await import("@/lib/loom-import-start");
		mockStartLoomImportWorkflow.mockRejectedValueOnce(
			new LoomImportStartError(true, new Error("queue rejected")),
		);
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(restore.set).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "uploading", rawFileKey: null }),
		);
		expect(restore.where).toHaveBeenCalledWith(
			expect.arrayContaining([
				{
					left: "videoUploads.updatedAt",
					right: claim.set.mock.calls[0]?.[0].updatedAt,
				},
			]),
		);
		expect(result.statuses).toEqual({ "retry-scheduled": 1 });
	});
});
