import type { VideoMetadata } from "@cap/database/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();
const mockStart = vi.fn();
const mockSetVideoProcessingError = vi.fn();
const mockGetLoomImportRunState = vi.fn();
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
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	})),
}));

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/lib/video-processing", () => ({
	setVideoProcessingError: mockSetVideoProcessingError,
}));

vi.mock("@/lib/loom-import-start", () => ({
	getLoomImportRunState: mockGetLoomImportRunState,
	LOOM_IMPORT_CONFIRMATION_MESSAGE: "Confirmation required",
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
	mockGetLoomImportRunState.mockResolvedValue("inactive");
	mockStartLoomImportWorkflow.mockResolvedValue(undefined);
});

describe("recoverFailedVideoProcessing", () => {
	it("keeps one recovery budget across indexed startup phases", async () => {
		const createCandidates = (
			phase: "uploading" | "processing",
			offset: number,
		) =>
			Array.from({ length: 8 }, (_, index) => ({
				...candidate,
				phase,
				videoId: `video-${index * 2 + offset}`,
				loomVideoId: `loom-${index * 2 + offset}`,
				uploadUpdatedAt: new Date(index * 2000 + offset * 1000),
				metadata: {
					loomImportRun: {
						runId: `run-${index * 2 + offset}`,
						dispatch: "accepted" as const,
					},
				},
			}));
		mockDb
			.mockReturnValueOnce(makeSelectChain(createCandidates("uploading", 0)))
			.mockReturnValueOnce(makeSelectChain(createCandidates("processing", 1)))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]));
		mockGetLoomImportRunState.mockResolvedValue("active");
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(result.checked).toBe(8);
		expect(result.results.map((row) => row.videoId)).toEqual(
			Array.from({ length: 8 }, (_, index) => `video-${index}`),
		);
		expect(mockGetLoomImportRunState).toHaveBeenCalledTimes(8);
		expect(mockStartLoomImportWorkflow).not.toHaveBeenCalled();
	});

	it("reserves a failed-import slot while uncertain startups remain protected", async () => {
		const pending = Array.from({ length: 8 }, (_, index) => ({
			...candidate,
			videoId: `pending-${index}`,
			loomVideoId: `pending-loom-${index}`,
			phase: "uploading",
			metadata: {
				loomImportRun: { runId: `run-${index}`, dispatch: "uncertain" },
			},
		}));
		const failedQuery = makeSelectChain([
			{ ...candidate, videoId: "failed-video", orgId: "organization-1" },
		]);
		mockDb
			.mockReturnValueOnce(makeSelectChain(pending))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(failedQuery)
			.mockReturnValueOnce(makeSelectChain([{ loomVideoId: "failed-loom" }]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValue(makeUpdateChain(1));
		mockGetLoomImportRunState.mockImplementation(async (receipt) =>
			receipt ? "unconfirmed" : "inactive",
		);
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		const result = await recoverFailedVideoProcessing();

		expect(failedQuery.limit).toHaveBeenCalledWith(1);
		expect(result.checked).toBe(8);
		expect(result.statuses).toEqual({
			"reconciliation-required": 7,
			started: 1,
		});
		expect(mockStartLoomImportWorkflow).toHaveBeenCalledTimes(1);
		expect(mockStartLoomImportWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({ videoId: "failed-video" }),
		);
	});

	it("atomically claims and restarts an affected upload", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain([]))
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
				.mockReturnValueOnce(makeSelectChain([]))
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
			mockGetLoomImportRunState.mockResolvedValueOnce("active");
			const { recoverFailedVideoProcessing } = await import(
				"@/lib/video-processing-recovery"
			);

			const result = await recoverFailedVideoProcessing();

			expect(mockStart).not.toHaveBeenCalled();
			expect(mockStartLoomImportWorkflow).not.toHaveBeenCalled();
			expect(result.statuses).toEqual({ "already-claimed": 1 });
			expect(mockDb).toHaveBeenCalledTimes(4);
			expect(mockGetLoomImportRunState).toHaveBeenCalledWith(receipt);
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

	it.each([
		{ phase: "uploading", state: "pending" },
		{ phase: "uploading", state: "unconfirmed" },
		{ phase: "processing", state: "pending" },
		{ phase: "processing", state: "unconfirmed" },
		{ phase: "processing", state: "inactive" },
	])(
		"exposes startup reconciliation without redispatching: %j",
		async (row) => {
			const receipt = {
				runId: "unresolved-run",
				dispatch: "uncertain" as const,
			};
			const selected = makeSelectChain([
				{
					...candidate,
					phase: row.phase,
					loomVideoId: "loom-video-1",
					metadata: { loomImportRun: receipt },
				},
			]);
			const update = makeUpdateChain(1);
			mockDb
				.mockReturnValueOnce(makeSelectChain([]))
				.mockReturnValueOnce(selected)
				.mockReturnValueOnce(makeSelectChain([]))
				.mockReturnValueOnce(makeSelectChain([]))
				.mockReturnValueOnce(update);
			mockGetLoomImportRunState.mockResolvedValueOnce(row.state);
			const { recoverFailedVideoProcessing } = await import(
				"@/lib/video-processing-recovery"
			);

			const result = await recoverFailedVideoProcessing();

			expect(result.statuses).toEqual({ "reconciliation-required": 1 });
			expect(update.set).toHaveBeenCalledWith({
				processingMessage: "Confirmation required",
				updatedAt: expect.any(Date),
			});
			expect(update.where).toHaveBeenCalledWith(
				expect.arrayContaining([
					{ left: "videoUploads.updatedAt", right: candidate.uploadUpdatedAt },
					expect.objectContaining({
						values: expect.arrayContaining(["unresolved-run"]),
					}),
				]),
			);
			expect(selected.select).toHaveBeenCalledWith(
				expect.objectContaining({ phase: "videoUploads.phase" }),
			);
			expect(mockStartLoomImportWorkflow).not.toHaveBeenCalled();
			expect(mockStart).not.toHaveBeenCalled();
		},
	);

	it("does not change reconciliation state after the selected claim changed", async () => {
		const update = makeUpdateChain(0);
		mockDb
			.mockReturnValueOnce(
				makeSelectChain([
					{
						...candidate,
						phase: "processing",
						loomVideoId: "loom-video-1",
						metadata: {
							loomImportRun: { runId: "old-run", dispatch: "pending" },
						},
					},
				]),
			)
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(update);
		mockGetLoomImportRunState.mockResolvedValueOnce("unconfirmed");
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		expect((await recoverFailedVideoProcessing()).statuses).toEqual({
			"already-claimed": 1,
		});
		expect(mockStartLoomImportWorkflow).not.toHaveBeenCalled();
	});

	it("recovers an uploading confirmation hold after its run becomes terminal", async () => {
		const update = makeUpdateChain(1);
		mockDb
			.mockReturnValueOnce(
				makeSelectChain([
					{
						...candidate,
						phase: "uploading",
						rawFileKey: null,
						loomVideoId: "loom-video-1",
						metadata: {
							loomImportRun: { runId: "terminal-run", dispatch: "uncertain" },
						},
					},
				]),
			)
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(makeSelectChain([]))
			.mockReturnValueOnce(update);
		mockGetLoomImportRunState.mockResolvedValueOnce("inactive");
		const { recoverFailedVideoProcessing } = await import(
			"@/lib/video-processing-recovery"
		);

		expect((await recoverFailedVideoProcessing()).statuses).toEqual({
			started: 1,
		});
		expect(update.where).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.arrayContaining([
					{
						left: "videoUploads.processingMessage",
						right: "Confirmation required",
					},
				]),
				expect.objectContaining({
					values: expect.arrayContaining(["terminal-run"]),
				}),
			]),
		);
		expect(mockStartLoomImportWorkflow).toHaveBeenCalledTimes(1);
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

		expect(mockDb).toHaveBeenCalledTimes(5);
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
