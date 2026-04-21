import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateWhereMock = vi.fn();
const selectWhereMock = vi.fn();
const runPromiseMock = vi.fn();
const fetchMock = vi.fn();

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

const serverEnvMock = vi.fn(() => ({
	MEDIA_SERVER_URL: "http://media-server:3000",
	MEDIA_SERVER_WEBHOOK_SECRET: undefined as string | undefined,
	MEDIA_SERVER_WEBHOOK_URL: undefined as string | undefined,
	WEB_URL: "http://localhost:3000",
}));

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

const mockBucket = {
	getInternalSignedObjectUrl: vi.fn(),
	getInternalPresignedPutUrl: vi.fn(),
};

const getBucketAccessMock = vi.fn();

vi.mock("@cap/web-backend", () => ({
	S3Buckets: {
		getBucketAccess: getBucketAccessMock,
	},
}));

vi.mock("@/lib/server", () => ({
	runPromise: runPromiseMock,
}));

describe("video processing starts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("fetch", fetchMock);

		getBucketAccessMock.mockReturnValue(Effect.succeed([mockBucket, null]));
		mockBucket.getInternalSignedObjectUrl.mockReturnValue(
			Effect.succeed("https://signed-url"),
		);
		mockBucket.getInternalPresignedPutUrl.mockReturnValue(
			Effect.succeed("https://presigned-url"),
		);
	});

	it("does not start processing when already running", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 0 });
		selectWhereMock.mockResolvedValueOnce([
			{
				videoId: "video-123",
				phase: "processing",
				rawFileKey: "user-123/video-123/raw-upload.webm",
			},
		]);

		const { startVideoProcessingDirect } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingDirect({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
			}),
		).resolves.toBe("already-processing");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(runPromiseMock).not.toHaveBeenCalled();
	});

	it("throws and marks error when MEDIA_SERVER_URL is not configured", async () => {
		serverEnvMock.mockReturnValue({
			MEDIA_SERVER_URL: undefined,
			MEDIA_SERVER_WEBHOOK_SECRET: undefined,
			MEDIA_SERVER_WEBHOOK_URL: undefined,
			WEB_URL: "http://localhost:3000",
		});
		updateWhereMock
			.mockResolvedValueOnce({ affectedRows: 1 })
			.mockResolvedValueOnce({ affectedRows: 1 });

		const { startVideoProcessingDirect } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingDirect({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "MEDIA_SERVER_URL not configured.",
			}),
		).rejects.toThrow("MEDIA_SERVER_URL is not configured");

		expect(updateWhereMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("calls media server and returns started when processing succeeds", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 1 });
		runPromiseMock
			.mockResolvedValueOnce([mockBucket, null])
			.mockResolvedValueOnce("https://raw-signed-url")
			.mockResolvedValueOnce("https://output-presigned-url")
			.mockResolvedValueOnce("https://thumbnail-presigned-url");
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ jobId: "job-abc" }),
		});

		const { startVideoProcessingDirect } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingDirect({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
				mode: "multipart",
			}),
		).resolves.toBe("started");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://media-server:3000/video/process",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("works when mysql returns affectedRows in the first tuple slot", async () => {
		updateWhereMock.mockResolvedValueOnce([{ affectedRows: 1 }]);
		runPromiseMock
			.mockResolvedValueOnce([mockBucket, null])
			.mockResolvedValueOnce("https://raw-signed-url")
			.mockResolvedValueOnce("https://output-presigned-url")
			.mockResolvedValueOnce("https://thumbnail-presigned-url");
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ jobId: "job-xyz" }),
		});

		const { startVideoProcessingDirect } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingDirect({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
				mode: "multipart",
			}),
		).resolves.toBe("started");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("marks the upload as errored when media server call fails", async () => {
		updateWhereMock
			.mockResolvedValueOnce({ affectedRows: 1 })
			.mockResolvedValueOnce({ affectedRows: 1 });
		runPromiseMock
			.mockResolvedValueOnce([mockBucket, null])
			.mockResolvedValueOnce("https://raw-signed-url")
			.mockResolvedValueOnce("https://output-presigned-url")
			.mockResolvedValueOnce("https://thumbnail-presigned-url");
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			json: () => Promise.resolve({ error: "media server error" }),
		});

		const { startVideoProcessingDirect } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingDirect({
				videoId: "video-123" as never,
				userId: "user-123",
				rawFileKey: "user-123/video-123/raw-upload.webm",
				bucketId: null,
				processingMessage: "Starting video processing...",
				startFailureMessage: "Video processing could not start.",
			}),
		).rejects.toThrow("media server error");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(updateWhereMock).toHaveBeenCalledTimes(2);
	});
});
