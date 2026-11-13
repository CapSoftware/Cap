import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const COMMENT_LIMIT = 3;

const mocks = vi.hoisted(() => ({
	notify: vi.fn(async () => undefined),
	userId: "viewer",
	selects: 0,
	inserted: [] as Row[],
	limitChecks: [] as Array<{ ruleId: string; key?: string }>,
	limitCounts: new Map<string, number>(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			mocks.selects += 1;
			return {
				from: () => {
					const rows = [{ id: "public-video", videoSettings: null }];
					const query = {
						leftJoin: () => query,
						innerJoin: () => query,
						where: () =>
							Object.assign(Promise.resolve(rows), {
								limit: async () => rows,
							}),
					};
					return query;
				},
			};
		},
		insert: () => ({
			values: async (row: Row) => {
				mocks.inserted.push(row);
			},
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: mocks.userId, name: "Viewer" }),
}));
vi.mock("@cap/web-domain", () => ({
	Comment: { CommentId: { make: (id: string) => id } },
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/comment-reply-parent", () => ({
	isReplyParentOnVideo: async () => true,
}));
vi.mock("@/lib/video-feedback-rules", () => ({
	isVideoFeedbackDisabled: async () => false,
}));
vi.mock("@/lib/Notification", () => ({ createNotification: mocks.notify }));
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: async (ruleId: string, opts?: { key?: string }) => {
		mocks.limitChecks.push({ ruleId, key: opts?.key });
		const bucket = `${ruleId}|${opts?.key}`;
		const count = (mocks.limitCounts.get(bucket) ?? 0) + 1;
		mocks.limitCounts.set(bucket, count);
		return count > COMMENT_LIMIT;
	},
}));

import { newComment } from "@/actions/videos/new-comment";

const post = (type: "text" | "emoji" = "text", parentCommentId = "") =>
	newComment({
		content: type === "emoji" ? "👍" : "hi",
		videoId: "public-video" as never,
		type,
		authorImage: null,
		parentCommentId: parentCommentId as never,
		timestamp: null,
	});

beforeEach(() => {
	mocks.userId = "viewer";
	mocks.selects = 0;
	mocks.inserted = [];
	mocks.limitChecks = [];
	mocks.limitCounts = new Map();
	mocks.notify.mockClear();
});

describe("comment creation limits", () => {
	it("stops saving and notifying once an author reaches the comment limit", async () => {
		for (let index = 0; index < COMMENT_LIMIT; index += 1) {
			await post(index % 2 === 0 ? "text" : "emoji");
		}
		await expect(post()).rejects.toThrow("Too many comments");
		await expect(post("emoji")).rejects.toThrow("Too many comments");
		await expect(post("text", "parent")).rejects.toThrow("Too many comments");

		expect(mocks.inserted).toHaveLength(COMMENT_LIMIT);
		expect(mocks.notify).toHaveBeenCalledTimes(COMMENT_LIMIT);
		expect(mocks.limitChecks).toEqual(
			Array.from({ length: COMMENT_LIMIT + 3 }, () => ({
				ruleId: "rl_comment_create",
				key: "comment:user:viewer",
			})),
		);
	});

	it("checks the limit before reading or writing anything", async () => {
		mocks.limitCounts.set(
			"rl_comment_create|comment:user:viewer",
			COMMENT_LIMIT,
		);

		await expect(post()).rejects.toThrow("Too many comments");

		expect(mocks.selects).toBe(0);
		expect(mocks.inserted).toEqual([]);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("keeps other authors commenting", async () => {
		mocks.limitCounts.set(
			"rl_comment_create|comment:user:viewer",
			COMMENT_LIMIT,
		);
		mocks.userId = "another-viewer";

		await post();

		expect(mocks.inserted).toEqual([
			expect.objectContaining({ authorId: "another-viewer", content: "hi" }),
		]);
		expect(mocks.notify).toHaveBeenCalledOnce();
	});
});
