import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	reserve: vi.fn(),
	rateLimited: vi.fn(),
	listObjects: vi.fn(),
	createUploadTarget: vi.fn(),
}));

const video = { id: "video-1", ownerId: "owner-1" };

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
	verifyCommentMediaUploadToken: () => null,
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
					listObjects: mocks.listObjects,
					createUploadTarget: mocks.createUploadTarget,
				},
			]),
	},
}));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/comment-media-quota", () => ({
	MAX_MEDIA_OBJECTS_PER_VIDEO: 400,
	reserveCommentMediaObjects: mocks.reserve,
}));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { COMMENT_MEDIA_UPLOAD: "rl_comment_media_upload" },
	isRateLimited: mocks.rateLimited,
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

import { app } from "@/app/api/upload/[...route]/comment-media";

const initiate = (body: Record<string, unknown> = {}) =>
	app.request("/initiate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			videoId: "video-1",
			kind: "video",
			contentType: "video/webm",
			mode: "single",
			withThumbnail: true,
			...body,
		}),
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rateLimited.mockResolvedValue(false);
	mocks.reserve.mockResolvedValue(true);
	mocks.listObjects.mockReturnValue(Effect.succeed({ Contents: [{}, {}, {}] }));
	mocks.createUploadTarget.mockImplementation((key: string) =>
		Effect.succeed({ url: `https://upload.test/${key}` }),
	);
});

describe("comment media initiate limits", () => {
	it("issues upload targets for a normal media comment", async () => {
		const response = await initiate();

		expect(response.status).toBe(200);
		const body = (await response.json()) as { upload: { url: string } };
		expect(body.upload.url).toContain("comments/comment-1/media.webm");
		expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith({
			videoId: "video-1",
			objects: 2,
			storedObjects: 3,
		});
		expect(mocks.rateLimited).toHaveBeenCalledWith(
			"rl_comment_media_upload",
			expect.objectContaining({ key: "comment-media-upload:viewer-1" }),
		);
	});

	it("reserves one object for audio", async () => {
		const response = await initiate({
			kind: "audio",
			contentType: "audio/webm",
			withThumbnail: false,
		});

		expect(response.status).toBe(200);
		expect(mocks.reserve).toHaveBeenCalledWith(
			expect.objectContaining({ objects: 1 }),
		);
	});

	it("refuses with a clear error once the video is full", async () => {
		mocks.reserve.mockResolvedValue(false);

		const response = await initiate();

		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({
			error: "This video has reached its media comment limit",
		});
		expect(mocks.createUploadTarget).not.toHaveBeenCalled();
	});

	it("refuses a viewer who starts too many uploads", async () => {
		mocks.rateLimited.mockResolvedValue(true);

		const response = await initiate();

		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({
			error: "Too many media comments, slow down",
		});
		expect(mocks.reserve).not.toHaveBeenCalled();
		expect(mocks.createUploadTarget).not.toHaveBeenCalled();
	});

	it("does not reserve space for an unsupported content type", async () => {
		const response = await initiate({ contentType: "video/x-msvideo" });

		expect(response.status).toBe(415);
		expect(mocks.reserve).not.toHaveBeenCalled();
	});
});
