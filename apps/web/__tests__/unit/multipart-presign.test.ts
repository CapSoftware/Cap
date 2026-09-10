import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOwnedById: vi.fn(),
	storage: vi.fn(),
	sign: vi.fn(),
	database: vi.fn(),
	prepareReplacement: vi.fn(),
	invalidate: vi.fn(),
	head: vi.fn(),
	queueTranscription: vi.fn(),
	shouldQueueTranscription: vi.fn(),
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@/lib/desktop-reupload", () => ({
	prepareDesktopReupload: mocks.prepareReplacement,
	invalidateReuploadedVideo: mocks.invalidate,
}));
vi.mock("@cap/web-backend", async () => {
	const { Context, Layer } = await import("effect");
	return {
		Database: Context.GenericTag("test/Database"),
		VideosPolicy: Context.GenericTag("test/VideosPolicy"),
		Storage: { getAccessForVideo: mocks.storage },
		makeCurrentUserLayer: () => Layer.empty,
		provideOptionalAuth: (effect: unknown) => effect,
	};
});
vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { id: "owner" });
		await next();
	},
}));
vi.mock("@/lib/server", async () => {
	const { Effect, Context, Layer } = await import("effect");
	return {
		runPromise: (effect: Effect.Effect<unknown, unknown, unknown>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(
						Layer.succeed(Context.GenericTag("test/VideosPolicy"), {
							getOwnedById: mocks.getOwnedById,
						}),
					),
					Effect.provide(
						Layer.succeed(Context.GenericTag("test/Database"), {
							use: (callback: (client: unknown) => Promise<unknown>) =>
								Effect.tryPromise(() => callback(mocks.database())),
						}),
					),
				) as Effect.Effect<unknown>,
			),
	};
});
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(async () => {}),
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: mocks.queueTranscription,
	shouldQueueTranscriptionAfterMultipartComplete:
		mocks.shouldQueueTranscription,
}));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: vi.fn(),
}));

import { app } from "@/app/api/upload/[...route]/multipart";

const request = () =>
	app.request("/presign-part", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId: "missing-video",
			uploadId: "upload",
			partNumber: 1,
		}),
	});

describe("multipart presign ownership failures", () => {
	it("returns 404 without accessing storage for a missing or unowned video", async () => {
		mocks.getOwnedById.mockReturnValue(Effect.succeed(Option.none()));
		const response = await request();
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "Video not found",
			code: "VIDEO_NOT_FOUND",
		});
		expect(mocks.storage).not.toHaveBeenCalled();
	});

	it("does not reveal or sign a recording owned by someone else", async () => {
		mocks.getOwnedById.mockReturnValue(Effect.fail({ _tag: "PolicyDenied" }));
		const response = await request();
		expect(response.status).toBe(404);
		expect(mocks.storage).not.toHaveBeenCalled();
	});

	it("still signs a part for its owner", async () => {
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(Option.some([{ id: "missing-video" }])),
		);
		mocks.sign.mockReturnValue(Effect.succeed("https://uploads.example/part"));
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "s3",
					multipart: { getPresignedUploadPartUrl: mocks.sign },
				},
			]),
		);
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			provider: "s3",
			presignedUrl: "https://uploads.example/part",
		});
	});
});

describe("desktop reupload completion", () => {
	let events: string[];
	let updates: Record<string, unknown>[];
	beforeEach(() => {
		vi.clearAllMocks();
		events = [];
		updates = [];
		const client = {
			transaction: async (run: (tx: unknown) => Promise<void>) => run(client),
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						updates.push(values);
						events.push("publish");
					},
				}),
			}),
			delete: () => ({
				where: async () => {
					events.push("delete-upload");
				},
			}),
		};
		mocks.database.mockReturnValue(client);
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(
				Option.some([
					{
						id: "video",
						ownerId: "owner",
						source: { type: "desktopMP4", outputKey: "old.mp4" },
						bucketId: Option.none(),
						storageIntegrationId: Option.none(),
					},
				]),
			),
		);
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "s3",
					bucketName: "bucket",
					multipart: {
						complete: () =>
							Effect.sync(() => {
								events.push("complete");
								return { ETag: "new-video" };
							}),
					},
					headObject: mocks.head,
					copyObject: () =>
						Effect.succeed({ CopyObjectResult: { ETag: "new-video" } }),
				},
			]),
		);
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: "new-video", ContentLength: 100 }),
		);
		mocks.prepareReplacement.mockImplementation(async () => {
			events.push("retire");
			return { source: { type: "desktopMP4" }, transcriptionStatus: null };
		});
		mocks.invalidate.mockImplementation(async () => {
			events.push("invalidate");
		});
		mocks.shouldQueueTranscription.mockReturnValue(false);
		mocks.queueTranscription.mockResolvedValue({ success: true });
	});

	const complete = (replaceExisting?: boolean) =>
		app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: "upload",
				parts: [{ partNumber: 1, etag: "part", size: 100 }],
				durationInSecs: 5,
				replaceExisting,
			}),
		});

	it("publishes the new canonical bytes at the existing link before invalidating playback", async () => {
		const response = await complete(true);
		expect(response.status).toBe(200);
		expect(events).toEqual([
			"complete",
			"retire",
			"publish",
			"delete-upload",
			"invalidate",
		]);
		expect(mocks.storage).toHaveBeenCalledWith(expect.anything(), {
			resolvePublishedOutput: false,
		});
		expect(updates[0]).toMatchObject({
			source: { type: "desktopMP4" },
			transcriptionStatus: null,
		});
	});

	it("keeps a committed reupload successful when cache invalidation fails", async () => {
		mocks.invalidate.mockImplementationOnce(async () => {
			events.push("invalidate");
			throw new Error("CloudFront temporarily unavailable");
		});
		mocks.shouldQueueTranscription.mockReturnValue(true);
		mocks.queueTranscription.mockImplementationOnce(async () => {
			events.push("transcribe");
			return { success: true };
		});

		const response = await complete(true);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			objectIdentity: "new-video",
		});
		expect(events).toEqual([
			"complete",
			"retire",
			"publish",
			"delete-upload",
			"invalidate",
			"transcribe",
		]);
		expect(updates).toHaveLength(1);
		expect(mocks.queueTranscription).toHaveBeenCalledExactlyOnceWith("video");
	});

	it.each([false, undefined])(
		"keeps first uploads on the existing recording completion path: %s",
		async (replaceExisting) => {
			const response = await complete(replaceExisting);
			expect(response.status).toBe(200);
			expect(mocks.prepareReplacement).not.toHaveBeenCalled();
			expect(mocks.invalidate).not.toHaveBeenCalled();
			expect(updates[0]).not.toHaveProperty("source");
		},
	);
	it("does not publish an empty or mismatched replacement", async () => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: "old-video", ContentLength: 0 }),
		);
		const response = await complete(true);
		expect(response.status).toBe(500);
		expect(mocks.prepareReplacement).not.toHaveBeenCalled();
		expect(mocks.invalidate).not.toHaveBeenCalled();
		expect(updates).toEqual([]);
	});

	it("does not replace playback when storage completion fails", async () => {
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "s3",
					bucketName: "bucket",
					multipart: {
						complete: () => Effect.fail(new Error("upload failed")),
					},
				},
			]),
		);
		const response = await complete(true);
		expect(response.status).toBe(500);
		expect(mocks.prepareReplacement).not.toHaveBeenCalled();
		expect(updates).toEqual([]);
	});
});
