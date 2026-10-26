import { Comment } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	sendEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: mocks.sendEmail,
}));

import { createNotification } from "@/lib/Notification";

function prepareReply({
	recipientId = "comment-author",
	pauseReplies = false,
	existingReply = false,
}: {
	recipientId?: string | null;
	pauseReplies?: boolean;
	existingReply?: boolean;
} = {}) {
	mocks.query
		.mockResolvedValueOnce({ rows: [["video", "owner"]] })
		.mockResolvedValueOnce({ rows: [["owner", "owner-org", null]] })
		.mockResolvedValueOnce({ rows: recipientId ? [[recipientId]] : [] })
		.mockResolvedValueOnce({
			rows: [[{ notifications: { pauseReplies } }, "reply-org"]],
		})
		.mockResolvedValueOnce({ rows: existingReply ? [["existing-reply"]] : [] })
		.mockResolvedValueOnce({ rows: [{ affectedRows: 1, insertId: 0 }] });
}

function reply(authorId: string) {
	return createNotification({
		type: "reply",
		videoId: "video",
		authorId,
		comment: { id: "reply", content: "Following up" },
		parentCommentId: Comment.CommentId.make("parent"),
	});
}

function notificationInserts() {
	return mocks.query.mock.calls.filter(([query]) =>
		query.startsWith("insert into `notifications`"),
	);
}

beforeEach(() => {
	mocks.query.mockReset();
	mocks.query.mockRejectedValue(new Error("Unexpected query"));
});

describe("reply notifications", () => {
	it("does not notify someone replying to their own comment on another person's Cap", async () => {
		prepareReply();

		await expect(reply("comment-author")).resolves.toBeUndefined();

		expect(notificationInserts()).toHaveLength(0);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it.each(["another-viewer", "owner"])(
		"notifies the parent author when %s replies",
		async (authorId) => {
			prepareReply();

			await expect(reply(authorId)).resolves.toMatchObject({ success: true });

			const inserts = notificationInserts();
			expect(inserts).toHaveLength(1);
			expect(inserts[0]?.[1]).toEqual(
				expect.arrayContaining(["comment-author", "reply-org", "reply"]),
			);
			expect(mocks.sendEmail).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ name: "replies are paused", pauseReplies: true },
		{ name: "the reply was already delivered", existingReply: true },
		{ name: "the parent belongs to the video owner", recipientId: "owner" },
		{ name: "the parent no longer exists", recipientId: null },
	])("does not notify when $name", async ({ name: _name, ...options }) => {
		prepareReply(options);

		await expect(reply("another-viewer")).resolves.toBeUndefined();

		expect(notificationInserts()).toHaveLength(0);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});
});
