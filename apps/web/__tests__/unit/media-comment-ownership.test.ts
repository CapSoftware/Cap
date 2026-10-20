import { Comment, User, Video } from "@cap/web-domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	current: null as {
		ownerId: string;
		bucket: string | null;
		storageIntegrationId: string | null;
	} | null,
	insert: vi.fn(),
	lock: vi.fn(),
	notify: vi.fn(),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "test-author", name: "Synthetic author" }),
}));
vi.mock("@cap/database/schema", () => ({
	comments: {},
	videos: {
		id: "id",
		ownerId: "ownerId",
		bucket: "bucket",
		storageIntegrationId: "storageIntegrationId",
	},
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: async (run: (tx: unknown) => Promise<unknown>) =>
			run({
				select: () => ({
					from: () => ({
						where: () => ({
							for: async (lock: string) => {
								mocks.lock(lock);
								return mocks.current ? [mocks.current] : [];
							},
						}),
					}),
				}),
				insert: () => ({ values: mocks.insert }),
			}),
	}),
}));
vi.mock("@cap/web-domain", async (original) => ({
	...(await original<typeof import("@cap/web-domain")>()),
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
}));
vi.mock("@cap/web-backend", async () => {
	const { Context, Effect, Option } = await import("effect");
	const repo = Context.GenericTag("SyntheticVideosRepo");
	const policy = Context.GenericTag("SyntheticVideosPolicy");
	const video = {
		id: "test-video",
		ownerId: "test-owner",
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
	};
	return {
		VideosRepo: repo,
		VideosPolicy: policy,
		provideOptionalAuth: (effect: Effect.Effect<unknown, unknown, unknown>) =>
			effect.pipe(
				Effect.provideService(repo, {
					getById: () => Effect.succeed(Option.some([video])),
				}),
				Effect.provideService(policy, { canView: () => Effect.succeed(true) }),
			),
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{ headObject: () => Effect.succeed({ ContentLength: 9 }) },
				]),
		},
		verifyCommentMediaUploadToken: () => ({
			userId: "test-author",
			videoId: "test-video",
			commentId: "test-comment",
			kind: "video",
			key: "test-owner/test-video/comments/test-comment/media.webm",
			contentType: "video/webm",
			thumbnailKey: null,
		}),
	};
});
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/Notification", () => ({ createNotification: mocks.notify }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { newMediaComment } from "@/actions/videos/new-media-comment";

const input: Parameters<typeof newMediaComment>[0] = {
	videoId: Video.VideoId.make("test-video"),
	commentId: Comment.CommentId.make("test-comment"),
	uploadToken: "synthetic-token",
	kind: "video",
	durationSeconds: 1,
	parentCommentId: Comment.CommentId.make(""),
	timestamp: null,
	authorImage: null,
};

beforeEach(() => {
	mocks.current = {
		ownerId: User.UserId.make("test-owner"),
		bucket: null,
		storageIntegrationId: null,
	};
});

describe("media comment ownership fence", () => {
	it("publishes a verified media comment while holding the parent video lock", async () => {
		await newMediaComment(input);
		expect(mocks.lock).toHaveBeenCalledWith("update");
		expect(mocks.insert).toHaveBeenCalledWith(
			expect.objectContaining({
				mediaKey: "test-owner/test-video/comments/test-comment/media.webm",
			}),
		);
	});

	it.each(["owner", "bucket", "integration", "deleted"])(
		"rejects a late upload when %s changed before commit",
		async (change) => {
			if (!mocks.current) throw new Error("Missing synthetic fixture");
			if (change === "owner") mocks.current.ownerId = "test-target";
			if (change === "bucket") mocks.current.bucket = "test-bucket";
			if (change === "integration")
				mocks.current.storageIntegrationId = "test-drive";
			if (change === "deleted") mocks.current = null;
			await expect(newMediaComment(input)).rejects.toThrow(
				"ownership or storage changed",
			);
			expect(mocks.insert).not.toHaveBeenCalled();
			expect(mocks.notify).not.toHaveBeenCalled();
		},
	);
});
