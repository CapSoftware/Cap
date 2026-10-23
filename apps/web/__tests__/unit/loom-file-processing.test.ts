import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	transition: vi.fn(),
	start: vi.fn(),
	setError: vi.fn(),
}));

vi.mock("@/lib/video-processing", () => ({
	transitionVideoToProcessing: mocks.transition,
	setVideoProcessingError: mocks.setError,
}));

vi.mock("@/lib/loom-import-start", () => ({
	startLoomImportWorkflow: mocks.start,
	LoomImportStartError: class extends Error {
		constructor(
			readonly canRetry: boolean,
			cause: unknown,
		) {
			super("Loom startup failed", { cause });
		}
	},
}));

describe("large Loom file processing", () => {
	const input = {
		videoId: "existing-video" as never,
		userId: "owner-id",
		loomVideoId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		rawFileKey: "owner-id/existing-video/raw-upload.mp4",
		bucketId: null,
		processingMessage: "Processing Loom video...",
		startFailureMessage: "Loom file processing could not start.",
	};

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.transition.mockResolvedValue("started");
		mocks.start.mockResolvedValue(undefined);
		mocks.setError.mockResolvedValue(undefined);
	});

	it("claims the existing upload and reuses its raw source through the multipart Loom workflow", async () => {
		const { startLoomFileProcessingWorkflow } = await import(
			"@/lib/loom-file-processing"
		);
		await expect(startLoomFileProcessingWorkflow(input)).resolves.toBe(
			"started",
		);
		expect(mocks.transition).toHaveBeenCalledExactlyOnceWith({
			videoId: input.videoId,
			rawFileKey: input.rawFileKey,
			processingMessage: input.processingMessage,
		});
		expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
			videoId: input.videoId,
			userId: input.userId,
			rawFileKey: input.rawFileKey,
			bucketId: null,
			loomVideoId: input.loomVideoId,
			reuseExistingRawUpload: true,
			cleanupRawUpload: true,
		});
		expect(mocks.setError).not.toHaveBeenCalled();
	});

	it.each(["already-processing", "already-complete"])(
		"does not dispatch another run when the upload is %s",
		async (status) => {
			mocks.transition.mockResolvedValue(status);
			const { startLoomFileProcessingWorkflow } = await import(
				"@/lib/loom-file-processing"
			);
			await expect(startLoomFileProcessingWorkflow(input)).resolves.toBe(
				status,
			);
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);

	it("rejects an invalid source before claiming the upload", async () => {
		const { startLoomFileProcessingWorkflow } = await import(
			"@/lib/loom-file-processing"
		);
		await expect(
			startLoomFileProcessingWorkflow({ ...input, loomVideoId: "invalid" }),
		).rejects.toThrow("no valid Loom source mapping");
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("does not dispatch when claiming the upload fails", async () => {
		mocks.transition.mockRejectedValue(new Error("Claim changed"));
		const { startLoomFileProcessingWorkflow } = await import(
			"@/lib/loom-file-processing"
		);
		await expect(startLoomFileProcessingWorkflow(input)).rejects.toThrow(
			"Claim changed",
		);
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.setError).not.toHaveBeenCalled();
	});

	it("restores a retryable error only after a confirmed queue rejection", async () => {
		const { LoomImportStartError } = await import("@/lib/loom-import-start");
		const error = new LoomImportStartError(true, new Error("Rejected"));
		mocks.start.mockRejectedValue(error);
		const { startLoomFileProcessingWorkflow } = await import(
			"@/lib/loom-file-processing"
		);
		await expect(startLoomFileProcessingWorkflow(input)).rejects.toBe(error);
		expect(mocks.setError).toHaveBeenCalledExactlyOnceWith(
			input.videoId,
			input.startFailureMessage,
			error,
		);
	});

	it("keeps an uncertain dispatch claimed so it cannot be started twice", async () => {
		const { LoomImportStartError } = await import("@/lib/loom-import-start");
		const error = new LoomImportStartError(false, new Error("Response lost"));
		mocks.start.mockRejectedValue(error);
		const { startLoomFileProcessingWorkflow } = await import(
			"@/lib/loom-file-processing"
		);
		await expect(startLoomFileProcessingWorkflow(input)).rejects.toBe(error);
		expect(mocks.setError).not.toHaveBeenCalled();
	});
});
