import { User, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOwnedById: vi.fn(),
	storage: vi.fn(),
	s3Bucket: vi.fn(),
	listObjects: vi.fn(),
	listUploads: vi.fn(),
	abort: vi.fn(),
	deleteVideo: vi.fn(),
	uploadPhase: "uploading" as string | null,
}));

vi.mock("@cap/web-backend", async () => {
	const { Context, Layer } = await import("effect");
	return {
		Database: Context.GenericTag("test/Database"),
		VideosPolicy: Context.GenericTag("test/VideosPolicy"),
		Videos: Context.GenericTag("test/Videos"),
		Storage: { getAccessForVideo: mocks.storage },
		S3Buckets: { getBucketAccess: mocks.s3Bucket },
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
						Layer.succeed(Context.GenericTag("test/Videos"), {
							delete: mocks.deleteVideo,
						}),
					),
					Effect.provide(
						Layer.succeed(Context.GenericTag("test/Database"), {
							use: () =>
								Effect.succeed(
									mocks.uploadPhase === null
										? []
										: [{ phase: mocks.uploadPhase }],
								),
						}),
					),
				) as Effect.Effect<unknown>,
			),
	};
});

import { app } from "@/app/api/upload/[...route]/abandon";

const video = (type = "webMP4") => ({
	id: Video.VideoId.make("video"),
	ownerId: User.UserId.make("owner"),
	source: { type },
	bucketId: Option.none(),
});

const abandon = () =>
	app.request("/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ videoId: "video" }),
	});

describe("abandoning a take left mid-recording", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.uploadPhase = "uploading";
		mocks.getOwnedById.mockReturnValue(Effect.succeed(Option.some([video()])));
		mocks.listObjects.mockReturnValue(Effect.succeed({ Contents: [] }));
		mocks.storage.mockReturnValue(
			Effect.succeed([{ provider: "s3", listObjects: mocks.listObjects }]),
		);
		mocks.listUploads.mockReturnValue(
			Effect.succeed({
				Uploads: [
					{ Key: "owner/video/raw-upload.mp4", UploadId: "screen" },
					{ Key: "owner/video/camera-upload.mp4", UploadId: "camera" },
					{ Key: "owner/other/raw-upload.mp4", UploadId: "elsewhere" },
				],
			}),
		);
		mocks.abort.mockReturnValue(Effect.succeed(undefined));
		mocks.s3Bucket.mockReturnValue(
			Effect.succeed([
				{ multipart: { listUploads: mocks.listUploads, abort: mocks.abort } },
			]),
		);
		mocks.deleteVideo.mockReturnValue(Effect.succeed(undefined));
	});

	it("aborts the take's open uploads and deletes the cap", async () => {
		const response = await abandon();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "deleted" });
		expect(mocks.listUploads).toHaveBeenCalledWith(
			expect.objectContaining({ prefix: "owner/video/" }),
		);
		expect(mocks.abort.mock.calls).toEqual([
			["owner/video/raw-upload.mp4", "screen"],
			["owner/video/camera-upload.mp4", "camera"],
		]);
		expect(mocks.deleteVideo).toHaveBeenCalledWith("video");
	});

	it("finds uploads on storage that lists them only by exact key", async () => {
		mocks.listUploads.mockImplementation(({ prefix }: { prefix: string }) =>
			Effect.succeed({
				Uploads:
					prefix === "owner/video/raw-upload.mp4"
						? [{ Key: prefix, UploadId: "screen" }]
						: prefix === "owner/video/mic-upload.webm"
							? [{ Key: prefix, UploadId: "mic" }]
							: [],
			}),
		);
		expect(await (await abandon()).json()).toEqual({ status: "deleted" });
		expect(mocks.abort.mock.calls).toEqual([
			["owner/video/raw-upload.mp4", "screen"],
			["owner/video/mic-upload.webm", "mic"],
		]);
	});

	it("still deletes the cap when an upload was already gone", async () => {
		mocks.abort.mockReturnValueOnce(Effect.fail(new Error("NoSuchUpload")));
		const response = await abandon();
		expect(await response.json()).toEqual({ status: "deleted" });
		expect(mocks.abort).toHaveBeenCalledTimes(2);
		expect(mocks.deleteVideo).toHaveBeenCalledOnce();
	});

	it("keeps a cap that already has a finished track", async () => {
		mocks.listObjects.mockReturnValue(
			Effect.succeed({ Contents: [{ Key: "owner/video/raw-upload.mp4" }] }),
		);
		expect(await (await abandon()).json()).toEqual({ status: "kept" });
		expect(mocks.abort).not.toHaveBeenCalled();
		expect(mocks.deleteVideo).not.toHaveBeenCalled();
	});

	it.each(["processing", "complete", "error", null])(
		"keeps a cap whose upload is %s",
		async (phase) => {
			mocks.uploadPhase = phase;
			expect(await (await abandon()).json()).toEqual({ status: "kept" });
			expect(mocks.storage).not.toHaveBeenCalled();
			expect(mocks.deleteVideo).not.toHaveBeenCalled();
		},
	);

	it("keeps anything that isn't a web recording", async () => {
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(Option.some([video("desktopMP4")])),
		);
		expect(await (await abandon()).json()).toEqual({ status: "kept" });
		expect(mocks.deleteVideo).not.toHaveBeenCalled();
	});

	it("doesn't touch someone else's recording", async () => {
		mocks.getOwnedById.mockReturnValue(Effect.fail({ _tag: "PolicyDenied" }));
		const response = await abandon();
		expect(response.status).toBe(404);
		expect(mocks.storage).not.toHaveBeenCalled();
		expect(mocks.deleteVideo).not.toHaveBeenCalled();
	});
});
