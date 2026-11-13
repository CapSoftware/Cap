import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	head: vi.fn(),
	insert: vi.fn(),
}));

const video = { id: "video-1", ownerId: "owner-1" };
const mediaKey = "owner-1/video-1/comments/comment-1/media.webm";
const thumbnailKey = "owner-1/video-1/comments/comment-1/thumbnail.jpg";

vi.mock("@cap/database", () => ({
	db: () => ({
		insert: () => ({ values: mocks.insert }),
	}),
}));
vi.mock("@cap/database/schema", () => ({ comments: {} }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1", name: "User" }),
}));
vi.mock("@cap/web-domain", () => ({
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	verifyCommentMediaUploadToken: () => ({
		userId: "user-1",
		videoId: "video-1",
		commentId: "comment-1",
		kind: "video",
		key: mediaKey,
		thumbnailKey,
		contentType: "video/webm",
	}),
	VideosRepo: Effect.succeed({
		getById: () => Effect.succeed(Option.some([video])),
	}),
	VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					headObject: (key: string) =>
						key === thumbnailKey
							? mocks.head()
							: Effect.succeed({ ContentLength: 4096 }),
				},
			]),
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/comment-media", () => ({ sanitizeWaveform: () => undefined }));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/Notification", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));

import { newMediaComment } from "@/actions/videos/new-media-comment";

function storageError(cause: unknown) {
	return { _tag: "StorageError", cause: { _tag: "S3Error", cause } };
}

function s3Error(name: string, httpStatusCode: number) {
	return Object.assign(new Error(name), {
		name,
		$metadata: { httpStatusCode },
	});
}

async function postComment() {
	return newMediaComment({
		videoId: "video-1" as never,
		commentId: "comment-1" as never,
		uploadToken: "token",
		kind: "video",
		durationSeconds: 5,
		parentCommentId: "" as never,
		timestamp: null,
		hasThumbnail: true,
		authorImage: null,
	});
}

function savedThumbnailKey() {
	return mocks.insert.mock.calls[0]?.[0]?.mediaMeta?.thumbnailKey;
}

describe("newMediaComment thumbnail check", () => {
	beforeEach(() => {
		mocks.head.mockReset();
		mocks.insert.mockReset().mockResolvedValue(undefined);
	});

	it("keeps the thumbnail when its HEAD request fails transiently", async () => {
		mocks.head.mockReturnValue(
			Effect.fail(storageError(s3Error("ServiceUnavailable", 503))),
		);

		await postComment();

		expect(savedThumbnailKey()).toBe(thumbnailKey);
	});

	it("keeps the thumbnail when its HEAD request hits a network error", async () => {
		mocks.head.mockReturnValue(
			Effect.fail(storageError(new Error("socket hang up"))),
		);

		await postComment();

		expect(savedThumbnailKey()).toBe(thumbnailKey);
	});

	it("drops a thumbnail that storage reports missing", async () => {
		mocks.head.mockReturnValue(
			Effect.fail(storageError(s3Error("NotFound", 404))),
		);

		await postComment();

		expect(mocks.insert).toHaveBeenCalledOnce();
		expect(savedThumbnailKey()).toBeUndefined();
	});

	it("drops a thumbnail that Google Drive reports missing", async () => {
		mocks.head.mockReturnValue(
			Effect.fail({
				_tag: "StorageError",
				cause: Object.assign(new Error("Storage object not found"), {
					name: "GoogleDriveRequestError",
					status: 404,
				}),
			}),
		);

		await postComment();

		expect(mocks.insert).toHaveBeenCalledOnce();
		expect(savedThumbnailKey()).toBeUndefined();
	});

	it("keeps a thumbnail that exists", async () => {
		mocks.head.mockReturnValue(Effect.succeed({ ContentLength: 128 }));

		await postComment();

		expect(savedThumbnailKey()).toBe(thumbnailKey);
	});
});
