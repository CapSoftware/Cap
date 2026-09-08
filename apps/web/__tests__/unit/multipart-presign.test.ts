import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOwnedById: vi.fn(),
	storage: vi.fn(),
	sign: vi.fn(),
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
				) as Effect.Effect<unknown>,
			),
	};
});
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(),
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: vi.fn(),
	shouldQueueTranscriptionAfterMultipartComplete: vi.fn(),
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
