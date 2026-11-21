import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getById: vi.fn(),
	storage: vi.fn(),
	complete: vi.fn(),
	abort: vi.fn(),
	head: vi.fn(),
	deleteObject: vi.fn(),
}));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: vi.fn(),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));
vi.mock("@cap/web-backend", async () => {
	const { Context, Layer } = await import("effect");
	return {
		VideosRepo: Context.GenericTag("test/VideosRepo"),
		VideosPolicy: Context.GenericTag("test/VideosPolicy"),
		Storage: { getAccessForVideo: mocks.storage },
		makeCurrentUserLayer: () => Layer.empty,
		provideOptionalAuth: (effect: unknown) => effect,
		createCommentMediaUploadToken: vi.fn(),
		verifyCommentMediaUploadToken: () => ({
			userId: "commenter",
			videoId: "video",
			commentId: "comment",
			key: "owner/video/comments/comment/media.webm",
			thumbnailKey: null,
			contentType: "video/webm",
			kind: "video",
		}),
	};
});
vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { id: "commenter" });
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
						Layer.succeed(Context.GenericTag("test/VideosRepo"), {
							getById: mocks.getById,
						}),
					),
				) as Effect.Effect<unknown>,
			),
	};
});

import { app } from "@/app/api/upload/[...route]/comment-media";

const GIB = 1024 * 1024 * 1024;

const complete = (sizes: number[]) =>
	app.request("/complete", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			uploadToken: "token",
			uploadId: "upload",
			parts: sizes.map((size, index) => ({
				partNumber: index + 1,
				etag: `"etag-${index + 1}"`,
				size,
			})),
		}),
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getById.mockReturnValue(
		Effect.succeed(Option.some([{ id: "video", ownerId: "owner" }])),
	);
	mocks.complete.mockReturnValue(Effect.succeed({}));
	mocks.abort.mockReturnValue(Effect.succeed({}));
	mocks.deleteObject.mockReturnValue(Effect.succeed({}));
	mocks.storage.mockReturnValue(
		Effect.succeed([
			{
				provider: "s3",
				multipart: { complete: mocks.complete, abort: mocks.abort },
				headObject: mocks.head,
				deleteObject: mocks.deleteObject,
			},
		]),
	);
});

describe("comment media completion size ceiling", () => {
	it("keeps a completed comment recording within the ceiling", async () => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ContentLength: 3 * GIB, ContentType: "video/webm" }),
		);

		const response = await complete([GIB, GIB, GIB]);

		expect(response.status).toBe(200);
		expect(mocks.deleteObject).not.toHaveBeenCalled();
	});

	it("aborts before completing when the declared parts exceed the ceiling", async () => {
		const response = await complete([5 * GIB, 5 * GIB, 5 * GIB, 5 * GIB, 1]);

		expect(response.status).toBe(413);
		expect(mocks.abort).toHaveBeenCalledWith(
			"owner/video/comments/comment/media.webm",
			"upload",
		);
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("deletes an oversized object whose parts understated their sizes", async () => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ContentLength: 25 * GIB, ContentType: "video/webm" }),
		);

		const response = await complete([1, 1, 1, 1, 1]);

		expect(response.status).toBe(413);
		expect(mocks.deleteObject).toHaveBeenCalledWith(
			"owner/video/comments/comment/media.webm",
		);
	});
});
