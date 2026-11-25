import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const GIB = 1024 * 1024 * 1024;

const mocks = vi.hoisted(() => ({
	mediaSize: 0,
	thumbnailSize: 0,
	insert: vi.fn(),
	deleteObject: vi.fn(),
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
						Effect.succeed({
							ContentLength:
								key === thumbnailKey ? mocks.thumbnailSize : mocks.mediaSize,
						}),
					deleteObject: mocks.deleteObject,
				},
			]),
	},
}));
vi.mock("@/lib/comment-media-quota", () => ({
	MAX_MEDIA_OBJECT_BYTES: 2 * 1024 * 1024 * 1024,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/comment-media", () => ({ sanitizeWaveform: () => undefined }));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/Notification", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));

import { newMediaComment } from "@/actions/videos/new-media-comment";

const postComment = () =>
	newMediaComment({
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

beforeEach(() => {
	mocks.mediaSize = 12_000_000;
	mocks.thumbnailSize = 90_000;
	mocks.insert.mockReset().mockResolvedValue(undefined);
	mocks.deleteObject.mockReset().mockReturnValue(Effect.void);
});

describe("newMediaComment stored size", () => {
	it("saves a comment whose objects are within the limit", async () => {
		await postComment();

		expect(mocks.insert).toHaveBeenCalledOnce();
		expect(mocks.insert.mock.calls[0]?.[0]?.mediaMeta).toMatchObject({
			size: 12_000_000,
			thumbnailKey,
		});
		expect(mocks.deleteObject).not.toHaveBeenCalled();
	});

	it("deletes an oversize recording and saves no comment", async () => {
		mocks.mediaSize = 3 * GIB;

		await expect(postComment()).rejects.toThrow("Recording is too large");

		expect(mocks.deleteObject).toHaveBeenCalledExactlyOnceWith(mediaKey);
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("deletes an oversize thumbnail and keeps the comment without it", async () => {
		mocks.thumbnailSize = 3 * GIB;

		await postComment();

		expect(mocks.deleteObject).toHaveBeenCalledExactlyOnceWith(thumbnailKey);
		expect(mocks.insert).toHaveBeenCalledOnce();
		expect(
			mocks.insert.mock.calls[0]?.[0]?.mediaMeta?.thumbnailKey,
		).toBeUndefined();
	});
});
