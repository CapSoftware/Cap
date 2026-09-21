import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	where: vi.fn(),
	set: vi.fn(),
	start: vi.fn(),
	currentUser: vi.fn(),
	startProcessing: vi.fn(),
	setError: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: mocks.where }) }),
		update: () => ({ set: mocks.set }),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.currentUser,
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "videoId" },
	videoUploads: {
		videoId: "uploadVideoId",
		phase: "phase",
		updatedAt: "updatedAt",
	},
	importedVideos: {
		id: "importVideoId",
		orgId: "importOrgId",
		source: "source",
		sourceId: "sourceId",
	},
}));
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ column, value }),
	and: (...conditions: unknown[]) => ({ conditions }),
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: mocks.startProcessing,
	setVideoProcessingError: mocks.setError,
}));

import { retryVideoProcessing } from "@/actions/video/retry-processing";

const videoId = "video-1" as Video.VideoId;
const video = { id: videoId, ownerId: "owner-1", orgId: "org-1", bucket: null };
const updatedAt = new Date();
const upload = {
	phase: "error",
	rawFileKey: null,
	updatedAt,
	processingProgress: 0,
};

describe("Loom processing retries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.currentUser.mockResolvedValue({ id: "owner-1" });
		mocks.set.mockReturnValue({ where: mocks.where });
		mocks.start.mockResolvedValue({});
	});

	it("recovers a source lookup failure that has no raw file key", async () => {
		mocks.where
			.mockResolvedValueOnce([video])
			.mockResolvedValueOnce([upload])
			.mockResolvedValueOnce([{ source: "loom", sourceId: "loom-1" }])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);
		await expect(retryVideoProcessing({ videoId })).resolves.toEqual({
			success: true,
			status: "started",
		});
		expect(mocks.where.mock.calls[2]?.[0]).toEqual({
			conditions: [
				{ column: "importVideoId", value: videoId },
				{ column: "importOrgId", value: "org-1" },
			],
		});
		expect(mocks.start).toHaveBeenCalledWith(expect.anything(), [
			expect.objectContaining({
				videoId,
				rawFileKey: "owner-1/video-1/raw-upload.mp4",
				loomVideoId: "loom-1",
				reuseExistingRawUpload: true,
			}),
		]);
		expect(mocks.startProcessing).not.toHaveBeenCalled();
	});

	it("does not dispatch after losing the processing claim", async () => {
		mocks.where
			.mockResolvedValueOnce([video])
			.mockResolvedValueOnce([upload])
			.mockResolvedValueOnce([{ source: "loom", sourceId: "loom-1" }])
			.mockResolvedValueOnce([{ affectedRows: 0 }]);
		await expect(retryVideoProcessing({ videoId })).resolves.toEqual({
			success: true,
			status: "already-processing",
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("leaves a recently active import running", async () => {
		mocks.where
			.mockResolvedValueOnce([video])
			.mockResolvedValueOnce([{ ...upload, phase: "processing" }])
			.mockResolvedValueOnce([{ source: "loom", sourceId: "loom-1" }]);
		await expect(retryVideoProcessing({ videoId })).resolves.toEqual({
			success: true,
			status: "already-processing",
		});
		expect(mocks.set).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("requires a raw file for a regular upload", async () => {
		mocks.where
			.mockResolvedValueOnce([video])
			.mockResolvedValueOnce([upload])
			.mockResolvedValueOnce([]);
		await expect(retryVideoProcessing({ videoId })).rejects.toThrow(
			"No raw file key found for retry",
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("rejects a different owner's video", async () => {
		mocks.where.mockResolvedValueOnce([{ ...video, ownerId: "other-owner" }]);
		await expect(retryVideoProcessing({ videoId })).rejects.toThrow(
			"Unauthorized",
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
