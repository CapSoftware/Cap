import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const GIB = 1024 * 1024 * 1024;

const mocks = vi.hoisted(() => ({
	complete: vi.fn(),
	abort: vi.fn(),
	headObject: vi.fn(),
	deleteObject: vi.fn(),
	reserveBytes: vi.fn(),
	reserveObjects: vi.fn(),
	createUploadTarget: vi.fn(),
	createMultipart: vi.fn(),
}));

const video = { id: "video-1", ownerId: "owner-1" };
const key = "owner-1/video-1/comments/comment-1/media.webm";

vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { id: "viewer-1" });
		await next();
	},
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [] }) }),
		}),
	}),
}));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "comment-1" }));
vi.mock("@cap/database/schema", () => ({ comments: {} }));
vi.mock("drizzle-orm", () => ({
	and: () => undefined,
	eq: () => undefined,
	gt: () => undefined,
	inArray: () => undefined,
}));
vi.mock("@cap/web-domain", () => ({
	Comment: { CommentId: { make: (value: string) => value } },
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
	Video: {
		VideoId: { make: (value: string) => value },
		NotFoundError: class {},
	},
}));
vi.mock("@cap/web-backend", () => ({
	createCommentMediaUploadToken: () => "upload-token",
	verifyCommentMediaUploadToken: () => ({
		userId: "viewer-1",
		videoId: "video-1",
		key,
		contentType: "video/webm",
	}),
	makeCurrentUserLayer: () => Layer.empty,
	provideOptionalAuth: (effect: unknown) => effect,
	VideosRepo: Effect.succeed({
		getById: () => Effect.succeed(Option.some([video])),
	}),
	VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					provider: "aws",
					multipart: {
						complete: mocks.complete,
						abort: mocks.abort,
						create: mocks.createMultipart,
					},
					headObject: mocks.headObject,
					deleteObject: mocks.deleteObject,
					listObjects: () => Effect.succeed({ Contents: [] }),
					createUploadTarget: mocks.createUploadTarget,
				},
			]),
	},
}));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/comment-media-quota", () => ({
	MAX_MEDIA_OBJECT_BYTES: 2 * 1024 * 1024 * 1024,
	MAX_MEDIA_OBJECTS_PER_VIDEO: 400,
	reserveCommentMediaObjects: mocks.reserveObjects,
	reserveCommentMediaBytes: mocks.reserveBytes,
}));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { COMMENT_MEDIA_UPLOAD: "rl_comment_media_upload" },
	isRateLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

import { app } from "@/app/api/upload/[...route]/comment-media";

const complete = (parts: Array<{ partNumber: number; size: number }>) =>
	app.request("/complete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			uploadToken: "upload-token",
			uploadId: "upload-1",
			parts: parts.map((part) => ({
				...part,
				etag: `etag-${part.partNumber}`,
			})),
		}),
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.complete.mockReturnValue(Effect.succeed({}));
	mocks.abort.mockReturnValue(Effect.void);
	mocks.deleteObject.mockReturnValue(Effect.void);
	mocks.reserveBytes.mockResolvedValue(true);
	mocks.reserveObjects.mockResolvedValue(true);
	mocks.createUploadTarget.mockImplementation((key: string) =>
		Effect.succeed({ url: `https://upload.test/${key}` }),
	);
	mocks.createMultipart.mockReturnValue(
		Effect.succeed({ UploadId: "upload-1" }),
	);
});

describe("comment media complete size", () => {
	it("keeps a stored object within the limit", async () => {
		mocks.headObject.mockReturnValue(
			Effect.succeed({ ContentLength: 12_000_000, ContentType: "video/webm" }),
		);

		const response = await complete([
			{ partNumber: 1, size: 6_000_000 },
			{ partNumber: 2, size: 6_000_000 },
		]);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ key, size: 12_000_000 });
		expect(mocks.deleteObject).not.toHaveBeenCalled();
		expect(mocks.reserveBytes).toHaveBeenCalledExactlyOnceWith({
			videoId: "video-1",
			userId: "viewer-1",
			bytes: 12_000_000,
			objectKey: key,
		});
	});

	it("refuses reported sizes over the limit before completing", async () => {
		const response = await complete([{ partNumber: 1, size: 3 * GIB }]);

		expect(response.status).toBe(413);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.abort).toHaveBeenCalledWith(key, "upload-1");
	});

	it("deletes a stored object over the limit even when the reported sizes are small", async () => {
		mocks.headObject.mockReturnValue(
			Effect.succeed({ ContentLength: 3 * GIB, ContentType: "video/webm" }),
		);

		const response = await complete([{ partNumber: 1, size: 0 }]);

		expect(response.status).toBe(413);
		expect(mocks.deleteObject).toHaveBeenCalledExactlyOnceWith(key);
		expect(mocks.reserveBytes).not.toHaveBeenCalled();
	});

	it("deletes the object when the viewer is out of byte budget for the video", async () => {
		mocks.headObject.mockReturnValue(
			Effect.succeed({ ContentLength: 12_000_000, ContentType: "video/webm" }),
		);
		mocks.reserveBytes.mockResolvedValue(false);

		const response = await complete([{ partNumber: 1, size: 12_000_000 }]);

		expect(response.status).toBe(413);
		expect(mocks.deleteObject).toHaveBeenCalledExactlyOnceWith(key);
	});

	it("falls back to the reported size when storage gives no length", async () => {
		mocks.headObject.mockReturnValue(Effect.succeed({}));

		const response = await complete([{ partNumber: 1, size: 5_000_000 }]);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ size: 5_000_000 });
		expect(mocks.deleteObject).not.toHaveBeenCalled();
	});
});

const initiate = (body: Record<string, unknown>) =>
	app.request("/initiate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ videoId: "video-1", ...body }),
	});

describe("comment media initiate size", () => {
	it("signs a voice note upload for its exact size and charges it", async () => {
		const response = await initiate({
			kind: "audio",
			contentType: "audio/webm",
			mode: "single",
			size: 40_000,
		});

		expect(response.status).toBe(200);
		expect(mocks.createUploadTarget).toHaveBeenCalledExactlyOnceWith(
			expect.stringMatching(/\/media\.webm$/),
			expect.objectContaining({
				contentLength: 40_000,
				enforceContentLength: true,
			}),
		);
		expect(mocks.reserveBytes).toHaveBeenCalledExactlyOnceWith({
			videoId: "video-1",
			userId: "viewer-1",
			bytes: 40_000,
		});
	});

	it("refuses a direct upload without a size", async () => {
		const response = await initiate({
			kind: "audio",
			contentType: "audio/webm",
			mode: "single",
		});

		expect(response.status).toBe(400);
		expect(mocks.createUploadTarget).not.toHaveBeenCalled();
	});

	it("refuses a direct upload over the per-object limit", async () => {
		const response = await initiate({
			kind: "audio",
			contentType: "audio/webm",
			mode: "single",
			size: 3 * GIB,
		});

		expect(response.status).toBe(413);
		expect(mocks.createUploadTarget).not.toHaveBeenCalled();
	});

	it("refuses a direct upload past the viewer byte budget", async () => {
		mocks.reserveBytes.mockResolvedValue(false);

		const response = await initiate({
			kind: "audio",
			contentType: "audio/webm",
			mode: "single",
			size: 40_000,
		});

		expect(response.status).toBe(413);
		expect(mocks.createUploadTarget).not.toHaveBeenCalled();
		expect(mocks.reserveObjects).not.toHaveBeenCalled();
	});

	it("signs a video and its thumbnail for their sizes and charges both", async () => {
		const response = await initiate({
			kind: "video",
			contentType: "video/webm",
			mode: "single",
			size: 12_000_000,
			withThumbnail: true,
			thumbnailSize: 90_000,
		});

		expect(response.status).toBe(200);
		expect(mocks.createUploadTarget).toHaveBeenCalledWith(
			expect.stringMatching(/\/media\.webm$/),
			expect.objectContaining({
				contentLength: 12_000_000,
				enforceContentLength: true,
			}),
		);
		expect(mocks.createUploadTarget).toHaveBeenCalledWith(
			expect.stringMatching(/\/thumbnail\.jpg$/),
			expect.objectContaining({
				contentLength: 90_000,
				enforceContentLength: true,
			}),
		);
		expect(mocks.reserveBytes).toHaveBeenCalledExactlyOnceWith({
			videoId: "video-1",
			userId: "viewer-1",
			bytes: 12_090_000,
		});
		expect(mocks.createMultipart).not.toHaveBeenCalled();
	});

	it("skips the optional thumbnail when its size is missing", async () => {
		const response = await initiate({
			kind: "video",
			contentType: "video/webm",
			mode: "single",
			size: 12_000_000,
			withThumbnail: true,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ thumbnailUpload: null });
		expect(mocks.createUploadTarget).toHaveBeenCalledOnce();
		expect(mocks.reserveBytes).toHaveBeenCalledExactlyOnceWith({
			videoId: "video-1",
			userId: "viewer-1",
			bytes: 12_000_000,
		});
	});

	it("no longer starts multipart uploads", async () => {
		const response = await initiate({
			kind: "video",
			contentType: "video/webm",
			mode: "multipart",
			size: 12_000_000,
		});

		expect(response.status).toBe(400);
		expect(mocks.createMultipart).not.toHaveBeenCalled();
		expect(mocks.createUploadTarget).not.toHaveBeenCalled();
	});
});
