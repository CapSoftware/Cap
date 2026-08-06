import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();
const mockStart = vi.fn();
const mockTranscribeVideo = vi.fn();
const mockStartAiGeneration = vi.fn();

vi.mock("@cap/database", () => ({
	db: mockDb,
}));

vi.mock("@cap/database/schema", () => ({
	users: {
		id: "users.id",
		stripeSubscriptionStatus: "users.stripeSubscriptionStatus",
		thirdPartyStripeSubscriptionId: "users.thirdPartyStripeSubscriptionId",
	},
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		bucket: "videos.bucket",
		source: "videos.source",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		isScreenshot: "videos.isScreenshot",
		createdAt: "videos.createdAt",
		updatedAt: "videos.updatedAt",
	},
	videoUploads: {
		videoId: "videoUploads.videoId",
		phase: "videoUploads.phase",
		processingMessage: "videoUploads.processingMessage",
		processingError: "videoUploads.processingError",
		processingProgress: "videoUploads.processingProgress",
		rawFileKey: "videoUploads.rawFileKey",
		startedAt: "videoUploads.startedAt",
		updatedAt: "videoUploads.updatedAt",
	},
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	asc: vi.fn((value: unknown) => value),
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	gte: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	inArray: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	isNotNull: vi.fn((value: unknown) => value),
	isNull: vi.fn((value: unknown) => value),
	lte: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	or: vi.fn((...conditions: unknown[]) => conditions),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	})),
}));

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: mockTranscribeVideo,
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mockStartAiGeneration,
}));

vi.mock("@/workflows/process-video", () => ({
	processVideoWorkflow: vi.fn(),
}));

vi.mock("@/workflows/finalize-desktop-recording", () => ({
	finalizeDesktopRecordingWorkflow: vi.fn(),
}));

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

const now = new Date("2026-07-20T15:00:00.000Z");
const staleAt = new Date("2026-07-20T14:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	mockStart.mockResolvedValue({ runId: "run-1" });
	mockTranscribeVideo.mockResolvedValue({
		success: true,
		message: "Transcription workflow started",
	});
	mockStartAiGeneration.mockResolvedValue({
		success: true,
		message: "AI generation workflow started",
	});
});

describe("recoverStalledVideoPipeline", () => {
	it("atomically restarts recent stale media, transcription, and AI work", async () => {
		const mediaCandidate = {
			videoId: "video-media",
			userId: "user-1",
			bucketId: null,
			rawFileKey: "user-1/video-media/raw.mp4",
			sourceType: "webMP4",
			updatedAt: staleAt,
		};
		const transcriptionCandidate = {
			videoId: "video-transcription",
			userId: "user-1",
			transcriptionStatus: "PROCESSING",
			updatedAt: staleAt,
			stripeSubscriptionStatus: "active",
			thirdPartyStripeSubscriptionId: null,
		};
		const aiCandidate = {
			videoId: "video-ai",
			userId: "user-1",
			metadata: { aiGenerationStatus: "QUEUED" },
			updatedAt: staleAt,
			stripeSubscriptionStatus: "active",
			thirdPartyStripeSubscriptionId: null,
		};

		let dbCall = 0;
		mockDb.mockImplementation(() => {
			dbCall++;
			if (dbCall === 1) return makeSelectChain([mediaCandidate]);
			if (dbCall === 2) return makeSelectChain([transcriptionCandidate]);
			if (dbCall === 3) return makeSelectChain([aiCandidate]);
			return makeUpdateChain(1);
		});

		const { recoverStalledVideoPipeline } = await import(
			"@/lib/video-pipeline-recovery"
		);
		const result = await recoverStalledVideoPipeline({ now, concurrency: 1 });

		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(mockTranscribeVideo).toHaveBeenCalledTimes(1);
		expect(mockStartAiGeneration).toHaveBeenCalledTimes(1);
		expect(result.media.statuses).toEqual({ started: 1 });
		expect(result.transcription.statuses).toEqual({ started: 1 });
		expect(result.ai.statuses).toEqual({ started: 1 });
	});

	it("does not start a duplicate media workflow after a lost claim", async () => {
		const mediaCandidate = {
			videoId: "video-media",
			userId: "user-1",
			bucketId: null,
			rawFileKey: "user-1/video-media/raw.mp4",
			sourceType: "webMP4",
			updatedAt: staleAt,
		};

		let dbCall = 0;
		mockDb.mockImplementation(() => {
			dbCall++;
			if (dbCall === 1) return makeSelectChain([mediaCandidate]);
			if (dbCall <= 3) return makeSelectChain([]);
			return makeUpdateChain(0);
		});

		const { recoverStalledVideoPipeline } = await import(
			"@/lib/video-pipeline-recovery"
		);
		const result = await recoverStalledVideoPipeline({ now, concurrency: 1 });

		expect(mockStart).not.toHaveBeenCalled();
		expect(result.media.statuses).toEqual({ "already-claimed": 1 });
	});

	it("starts eligible AI generation when legacy metadata is null", async () => {
		const aiCandidate = {
			videoId: "video-ai",
			userId: "user-1",
			metadata: null,
			updatedAt: staleAt,
			stripeSubscriptionStatus: "active",
			thirdPartyStripeSubscriptionId: null,
		};

		let dbCall = 0;
		mockDb.mockImplementation(() => {
			dbCall++;
			if (dbCall < 3) return makeSelectChain([]);
			return makeSelectChain([aiCandidate]);
		});

		const { recoverStalledVideoPipeline } = await import(
			"@/lib/video-pipeline-recovery"
		);
		const result = await recoverStalledVideoPipeline({ now, concurrency: 1 });

		expect(mockStartAiGeneration).toHaveBeenCalledWith("video-ai", "user-1");
		expect(result.ai.statuses).toEqual({ started: 1 });
	});
});
