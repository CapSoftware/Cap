import { beforeEach, describe, expect, it, vi } from "vitest";

const updateWhereMock = vi.fn();
const selectWhereMock = vi.fn();
const startMock = vi.fn();

const dbMock = vi.fn(() => ({
	update: vi.fn(() => ({
		set: vi.fn(() => ({
			where: updateWhereMock,
		})),
	})),
	select: vi.fn(() => ({
		from: vi.fn(() => ({
			where: selectWhereMock,
		})),
	})),
}));

vi.mock("@cap/database", () => ({
	db: dbMock,
}));

vi.mock("server-only", () => ({}));

vi.mock("workflow/api", () => ({
	start: startMock,
}));

vi.mock("@/workflows/process-video", () => ({
	processVideoWorkflow: Symbol("processVideoWorkflow"),
}));

describe("video processing starts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not start a duplicate workflow when processing is already running", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 0 });
		selectWhereMock.mockResolvedValueOnce([
			{
				videoId: "video-123",
				phase: "processing",
				rawFileKey: "user-123/video-123/raw-upload.webm",
			},
		]);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
			}),
		).resolves.toBe("already-processing");

		expect(startMock).not.toHaveBeenCalled();
	});

	it("starts the workflow after claiming the upload row", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 1 });
		startMock.mockResolvedValueOnce(undefined);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
				mode: "multipart",
			}),
		).resolves.toBe("started");

		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("starts the workflow when mysql returns affectedRows in the first tuple slot", async () => {
		updateWhereMock.mockResolvedValueOnce([{ affectedRows: 1 }]);
		startMock.mockResolvedValueOnce(undefined);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
				mode: "multipart",
			}),
		).resolves.toBe("started");

		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("force restarts a stale processing row", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 1 });
		startMock.mockResolvedValueOnce(undefined);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Retrying video processing...",
				startFailureMessage: "Video processing could not restart.",
				forceRestart: true,
			}),
		).resolves.toBe("started");

		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("marks the upload as errored when workflow start fails", async () => {
		updateWhereMock
			.mockResolvedValueOnce({ affectedRows: 1 })
			.mockResolvedValueOnce({ affectedRows: 1 });
		startMock.mockRejectedValueOnce(new Error("temporary failure"));

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
			}),
		).rejects.toThrow("temporary failure");

		expect(startMock).toHaveBeenCalledTimes(1);
		expect(updateWhereMock).toHaveBeenCalledTimes(2);
	});
});
