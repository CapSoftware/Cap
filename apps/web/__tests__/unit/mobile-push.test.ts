import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	config: { keyId: "k", teamId: "t", privateKey: "p" } as unknown,
	firstViewId: "n1" as string | null,
	joinedSessions: 0,
	tokens: [] as { token: string; environment: string }[],
	results: new Map<string, string>(),
	sent: [] as { targets: unknown; message: unknown }[],
	deleted: [] as unknown[],
	firstViewQueries: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({
	after: () => {
		throw new Error("outside request scope");
	},
}));
vi.mock("@/lib/apns", () => ({
	apnsConfig: () => mocks.config,
	sendPushes: async (_config: unknown, targets: unknown, message: unknown) => {
		mocks.sent.push({ targets, message });
		return mocks.results;
	},
}));
vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	return {
		db: () => ({
			select: () => {
				let table: unknown;
				let ordered = false;
				const query = {
					from: (value: unknown) => {
						table = value;
						return query;
					},
					innerJoin: (joined: unknown) => {
						if (joined === schema.authApiKeys) mocks.joinedSessions += 1;
						return query;
					},
					where: () => query,
					orderBy: () => {
						ordered = true;
						return query;
					},
					limit: async () => {
						if (table === schema.mobilePushTokens) return mocks.tokens;
						if (table === schema.notifications) {
							if (!ordered)
								return [{ createdAt: new Date("2026-11-09T12:03:00Z") }];
							mocks.firstViewQueries += 1;
							return mocks.firstViewId ? [{ id: mocks.firstViewId }] : [];
						}
						if (table === schema.videos) return [{ name: "Launch demo" }];
						if (table === schema.users) return [{ name: "Alex" }];
						return [];
					},
				};
				return query;
			},
			delete: () => ({
				where: async (condition: unknown) => {
					mocks.deleted.push(condition);
				},
			}),
		}),
	};
});

import {
	deliverNotificationPush,
	pushMessageFor,
	queueNotificationPush,
} from "@/lib/mobile-push";

beforeEach(() => {
	mocks.config = { keyId: "k", teamId: "t", privateKey: "p" };
	mocks.firstViewId = "n1";
	mocks.joinedSessions = 0;
	mocks.tokens = [{ token: "aa11", environment: "production" }];
	mocks.results = new Map([["aa11", "sent"]]);
	mocks.sent = [];
	mocks.deleted = [];
	mocks.firstViewQueries = 0;
});

describe("push copy", () => {
	it("names the person and what they did", () => {
		const base = { capId: "cap1", capName: "Launch demo", actorName: "Alex" };
		expect(
			pushMessageFor({ ...base, type: "comment", content: "Love it" }),
		).toEqual({
			title: "Launch demo",
			body: "Alex commented: Love it",
			capId: "cap1",
		});
		expect(
			pushMessageFor({ ...base, type: "reply", content: "Thanks" }).body,
		).toBe("Alex replied: Thanks");
		expect(
			pushMessageFor({ ...base, type: "reaction", content: "👍" }).body,
		).toBe("Alex reacted 👍");
		expect(pushMessageFor({ ...base, type: "view" }).body).toBe(
			"Alex watched your Cap",
		);
	});

	it("falls back when names are missing and shortens long comments", () => {
		const message = pushMessageFor({
			type: "comment",
			capId: "cap1",
			capName: null,
			actorName: null,
			content: `${"word ".repeat(60)}\nend`,
		});
		expect(message.title).toBe("Your Cap");
		expect(message.body.startsWith("Someone commented: word word")).toBe(true);
		expect(message.body.length).toBeLessThanOrEqual(
			"Someone commented: ".length + 140,
		);
		expect(message.body.endsWith("…")).toBe(true);
		expect(message.body).not.toContain("\n");
	});
});

describe("notification push delivery", () => {
	const comment = {
		notificationId: "n1",
		type: "comment" as const,
		recipientId: "owner",
		videoId: "cap1",
		authorId: "author",
		content: "Love it",
	};

	it("sends to every token the recipient registered", async () => {
		await deliverNotificationPush(comment);
		expect(mocks.sent).toEqual([
			{
				targets: [{ token: "aa11", environment: "production" }],
				message: {
					title: "Launch demo",
					body: "Alex commented: Love it",
					capId: "cap1",
				},
			},
		]);
		expect(mocks.firstViewQueries).toBe(0);
		expect(mocks.joinedSessions).toBe(1);
	});

	it("does nothing when APNs isn't configured", async () => {
		mocks.config = null;
		await deliverNotificationPush(comment);
		expect(mocks.sent).toHaveLength(0);
	});

	it("skips a view push when an earlier view in the same 10 minutes already pushed", async () => {
		mocks.firstViewId = "earlier";
		await deliverNotificationPush({
			...comment,
			type: "view",
			content: undefined,
		});
		expect(mocks.firstViewQueries).toBe(1);
		expect(mocks.sent).toHaveLength(0);
	});

	it("pushes the view that comes first in its 10 minutes", async () => {
		await deliverNotificationPush({
			...comment,
			type: "view",
			content: undefined,
		});
		expect(mocks.firstViewQueries).toBe(1);
		expect(mocks.sent).toHaveLength(1);
	});

	it("sends the first anonymous view with the viewer's name", async () => {
		await deliverNotificationPush({
			notificationId: "n1",
			type: "anon_view",
			recipientId: "owner",
			videoId: "cap1",
			anonName: "Anonymous Otter",
		});
		expect(mocks.sent[0]?.message).toEqual({
			title: "Launch demo",
			body: "Anonymous Otter watched your Cap",
			capId: "cap1",
		});
	});

	it("deletes tokens Apple reports as dead and keeps the rest", async () => {
		mocks.tokens = [
			{ token: "aa11", environment: "production" },
			{ token: "bb22", environment: "production" },
		];
		mocks.results = new Map([
			["aa11", "invalid-token"],
			["bb22", "failed"],
		]);
		await deliverNotificationPush(comment);
		expect(mocks.deleted).toHaveLength(1);
	});

	it("skips the delete when every token worked or no tokens exist", async () => {
		await deliverNotificationPush(comment);
		mocks.tokens = [];
		await deliverNotificationPush(comment);
		expect(mocks.deleted).toHaveLength(0);
		expect(mocks.sent).toHaveLength(1);
	});

	it("starts delivery outside a request scope without throwing", async () => {
		expect(() => queueNotificationPush(comment)).not.toThrow();
		await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
	});
});
