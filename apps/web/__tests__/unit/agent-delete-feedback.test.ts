import { Comment, User, Video } from "@cap/web-domain";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAgentFeedback } from "@/lib/agent-write";

vi.mock("server-only", () => ({}));

const query = vi.fn();
const tx = drizzle(query) as unknown as Parameters<
	typeof deleteAgentFeedback
>[0];

const commentId = Comment.CommentId.make("feedback");
const videoId = Video.VideoId.make("video");
const authorId = User.UserId.make("agent-user");

const deleteFeedback = () =>
	deleteAgentFeedback(tx, { videoId, commentId, authorId });

const notificationDeletes = () =>
	query.mock.calls.filter(([statement]) =>
		statement.startsWith("delete from `notifications`"),
	);

const givenComment = (parentCommentId: string | null) => {
	query.mockResolvedValueOnce({ rows: [[parentCommentId]] });
};

beforeEach(() => {
	query.mockReset();
	query.mockResolvedValue({ rows: [{ affectedRows: 1, insertId: 0 }] });
});

describe("agent feedback deletion", () => {
	it.each([null, ""])(
		"removes the notifications of a deleted root with parent %j",
		async (parentCommentId) => {
			givenComment(parentCommentId);

			await expect(deleteFeedback()).resolves.toBe(true);

			expect(query).toHaveBeenCalledWith(
				expect.stringContaining("delete from `comments`"),
				[commentId, videoId, authorId],
				"execute",
			);
			expect(notificationDeletes()).toEqual([
				[
					expect.stringContaining(
						"`notifications`.`videoId` = ? and `notifications`.`type` in (?, ?) and JSON_EXTRACT(`notifications`.`data`, '$.comment.id') = ?",
					),
					[videoId, "comment", "reaction", commentId],
					"execute",
				],
				[
					expect.stringContaining(
						"`notifications`.`videoId` = ? and `notifications`.`type` = ? and JSON_EXTRACT(`notifications`.`data`, '$.parentCommentId') = ?",
					),
					[videoId, "reply", commentId],
					"execute",
				],
			]);
		},
	);

	it("removes only the reply notification of a deleted reply", async () => {
		givenComment("parent");

		await expect(deleteFeedback()).resolves.toBe(true);

		expect(notificationDeletes()).toEqual([
			[
				expect.stringContaining(
					"`notifications`.`videoId` = ? and `notifications`.`type` = ? and JSON_EXTRACT(`notifications`.`data`, '$.comment.id') = ?",
				),
				[videoId, "reply", commentId],
				"execute",
			],
		]);
	});

	it("deletes nothing when the caller does not own the feedback", async () => {
		query.mockResolvedValueOnce({ rows: [] });

		await expect(deleteFeedback()).resolves.toBe(false);

		expect(query).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("for update"),
			[commentId, videoId, authorId, 1],
			"all",
		);
	});
});
