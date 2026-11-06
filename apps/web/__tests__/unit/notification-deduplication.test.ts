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
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: mocks.sendEmail,
}));

import {
	createAnonymousViewNotification,
	createNotification,
} from "@/lib/Notification";

type AuthoredType = "view" | "comment" | "reaction" | "reply";

function notify(type: AuthoredType, eventId = "event", authorId = "viewer") {
	return createNotification(
		type === "view"
			? { type, videoId: eventId, authorId }
			: {
					type,
					videoId: "video",
					authorId,
					comment: { id: eventId, content: "Hello" },
					parentCommentId:
						type === "reply" ? Comment.CommentId.make("parent") : undefined,
				},
	);
}

function storeNotifications(insertError?: Error) {
	const inserted: unknown[][] = [];
	const dedupKeys = new Set<unknown>();

	mocks.query.mockImplementation(async (query: string, params: unknown[]) => {
		if (query.startsWith("insert into `notifications`")) {
			if (insertError) throw insertError;
			const dedupKey = params[6];
			if (dedupKey !== undefined && dedupKeys.has(dedupKey)) {
				throw Object.assign(
					new Error("Duplicate entry for key 'dedup_key_idx'"),
					{
						code: "ER_DUP_ENTRY",
						errno: 1062,
					},
				);
			}
			if (dedupKey !== undefined) dedupKeys.add(dedupKey);
			inserted.push(params);
			return { rows: [{ affectedRows: 1, insertId: 0 }] };
		}
		if (query.includes("from `notifications`")) return { rows: [] };
		if (query.includes("from `videos`"))
			return {
				rows: [
					query.includes("inner join")
						? [params[0], "owner", "org", null]
						: [params[0], "owner"],
				],
			};
		if (query.includes("from `comments`"))
			return {
				rows: query.startsWith("select `authorId`") ? [["parent-author"]] : [],
			};
		if (query.includes("from `users`")) {
			if (query.includes("`preferences`"))
				return {
					rows:
						params[0] === "owner" ? [["owner", "org", null]] : [[null, "org"]],
				};
			return { rows: [["owner@example.com"]] };
		}
		throw new Error(`Unexpected query: ${query}`);
	});

	return inserted;
}

beforeEach(() => {
	mocks.query.mockReset();
	mocks.sendEmail.mockReset();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("authored notification deduplication", () => {
	it.each<AuthoredType>(["view", "comment", "reaction", "reply"])(
		"stores one %s notification when concurrent requests both miss the existing row",
		async (type) => {
			const inserted = storeNotifications();

			const results = await Promise.all([notify(type), notify(type)]);

			expect(inserted).toHaveLength(1);
			expect(results.filter((result) => result?.success)).toHaveLength(1);
			expect(mocks.sendEmail).toHaveBeenCalledTimes(type === "comment" ? 1 : 0);
		},
	);

	it.each<AuthoredType>(["view", "comment", "reaction", "reply"])(
		"keeps distinct %s events",
		async (type) => {
			const inserted = storeNotifications();

			await Promise.all([notify(type, "first"), notify(type, "second")]);

			expect(inserted).toHaveLength(2);
		},
	);

	it("keeps views by different viewers on the same Cap", async () => {
		const inserted = storeNotifications();

		await Promise.all([
			notify("view", "video", "viewer-one"),
			notify("view", "video", "viewer-two"),
		]);

		expect(inserted).toHaveLength(2);
	});

	it("also handles Drizzle-wrapped duplicate errors for anonymous views", async () => {
		const inserted = storeNotifications();
		const view = {
			videoId: "video",
			sessionId: "session",
			anonName: "Anonymous Otter",
			location: null,
		};

		await Promise.all([
			createAnonymousViewNotification(view),
			createAnonymousViewNotification(view),
		]);

		expect(inserted).toHaveLength(1);
	});

	it("still skips existing notifications without a dedup key", async () => {
		const inserted = storeNotifications();
		mocks.query
			.mockResolvedValueOnce({ rows: [["video", "owner"]] })
			.mockResolvedValueOnce({ rows: [["owner", "org", null]] })
			.mockResolvedValueOnce({ rows: [["legacy-notification"]] });

		await expect(notify("view")).resolves.toBeUndefined();

		expect(inserted).toHaveLength(0);
	});

	it.each([
		new Error("Connection lost"),
		Object.assign(new Error("Duplicate entry for key 'PRIMARY'"), {
			code: "ER_DUP_ENTRY",
			errno: 1062,
		}),
	])("does not swallow unrelated insert errors: %s", async (error) => {
		storeNotifications(error);

		await expect(notify("view")).rejects.toMatchObject({ cause: error });
	});
});
