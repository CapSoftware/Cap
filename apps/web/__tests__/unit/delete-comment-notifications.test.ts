import { Comment, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getCurrentUser: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return {
		db: () => ({
			transaction: <T>(callback: (tx: typeof client) => Promise<T>) =>
				callback(client),
		}),
	};
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/web-backend", () => ({ Storage: {}, VideosRepo: {} }));
vi.mock("@/lib/server", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { deleteComment } from "@/actions/videos/delete-comment";

const commentId = Comment.CommentId.make("reaction");
const videoId = Video.VideoId.make("video");

beforeEach(() => {
	mocks.getCurrentUser.mockResolvedValue({ id: "viewer" });
	mocks.query.mockReset();
	mocks.query.mockResolvedValue({ rows: [{ affectedRows: 1, insertId: 0 }] });
	mocks.query.mockResolvedValueOnce({
		rows: [[commentId, videoId, null, null]],
	});
});

describe("deleted comment notifications", () => {
	it.each([null, Comment.CommentId.make("")])(
		"removes the reaction notification for a root with parent %j",
		async (parentId) => {
			await expect(
				deleteComment({ commentId, videoId, parentId }),
			).resolves.toEqual({ success: true });

			expect(mocks.query).toHaveBeenCalledWith(
				expect.stringContaining("delete from `comments`"),
				[commentId, "viewer"],
				"execute",
			);
			expect(mocks.query).toHaveBeenCalledWith(
				expect.stringContaining(
					"where (`notifications`.`type` in (?, ?) and JSON_EXTRACT(`notifications`.`data`, '$.comment.id') = ?)",
				),
				["comment", "reaction", commentId],
				"execute",
			);
			expect(mocks.query).toHaveBeenCalledWith(
				expect.stringContaining("'$.comment.parentCommentId'"),
				["reply", commentId],
				"execute",
			);
			expect(mocks.revalidatePath).toHaveBeenCalledWith(`/s/${videoId}`);
		},
	);

	it("still removes only the reply notification when deleting a reply", async () => {
		await deleteComment({
			commentId,
			videoId,
			parentId: Comment.CommentId.make("parent"),
		});

		const deletes = mocks.query.mock.calls.filter(([query]) =>
			query.startsWith("delete from `notifications`"),
		);
		expect(deletes).toEqual([
			[
				expect.stringContaining("'$.comment.id'"),
				["reply", commentId],
				"execute",
			],
		]);
	});

	it("does not delete notifications for a missing or unowned comment", async () => {
		mocks.query.mockReset();
		mocks.query.mockResolvedValue({ rows: [] });
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			deleteComment({ commentId, videoId, parentId: null }),
		).rejects.toThrow("Comment not found or you don't have permission");

		expect(mocks.query).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("`comments`.`authorId` = ?"),
			[commentId, "viewer", 1],
			"all",
		);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});
});
