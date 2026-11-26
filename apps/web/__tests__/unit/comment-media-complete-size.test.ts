import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const GIB = 1024 * 1024 * 1024;

const mocks = vi.hoisted(() => ({
	complete: vi.fn(),
	abort: vi.fn(),
	headObject: vi.fn(),
	deleteObject: vi.fn(),
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
					multipart: { complete: mocks.complete, abort: mocks.abort },
					headObject: mocks.headObject,
					deleteObject: mocks.deleteObject,
				},
			]),
	},
}));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/comment-media-quota", () => ({
	MAX_MEDIA_OBJECTS_PER_VIDEO: 400,
	reserveCommentMediaObjects: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { COMMENT_MEDIA_UPLOAD: "rl_comment_media_upload" },
	isRateLimited: vi.fn(),
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
	});

	it("refuses reported sizes over the limit before completing", async () => {
		const response = await complete([{ partNumber: 1, size: 21 * GIB }]);

		expect(response.status).toBe(413);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.abort).toHaveBeenCalledWith(key, "upload-1");
	});

	it("deletes a stored object over the limit even when the reported sizes are small", async () => {
		mocks.headObject.mockReturnValue(
			Effect.succeed({ ContentLength: 21 * GIB, ContentType: "video/webm" }),
		);

		const response = await complete([{ partNumber: 1, size: 0 }]);

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
