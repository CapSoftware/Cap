import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	config: { keyId: "k", teamId: "t", privateKey: "p" } as unknown,
	claims: new Set<string>(),
	claimAttempts: [] as string[],
	joinedSessions: 0,
	tokens: [] as { token: string; environment: string }[],
	results: new Map<string, string>(),
	sent: [] as { targets: unknown; message: unknown }[],
	deleted: [] as { table: unknown; condition: unknown }[],
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
					orderBy: () => query,
					limit: async () => {
						if (table === schema.mobilePushTokens) return mocks.tokens;
						if (table === schema.videos) return [{ name: "Launch demo" }];
						if (table === schema.users) return [{ name: "Alex" }];
						return [];
					},
				};
				return query;
			},
			insert: () => ({
				values: async ({ id }: { id: string }) => {
					mocks.claimAttempts.push(id);
					if (mocks.claims.has(id)) {
						throw Object.assign(new Error("Failed query"), {
							cause: Object.assign(new Error("Duplicate entry"), {
								code: "ER_DUP_ENTRY",
								errno: 1062,
							}),
						});
					}
					mocks.claims.add(id);
				},
			}),
			delete: (table: unknown) => ({
				where: (condition: unknown) => {
					mocks.deleted.push({ table, condition });
					const done = Promise.resolve();
					return Object.assign(done, { limit: async () => {} });
				},
			}),
		}),
	};
});

import * as schemaRef from "@cap/database/schema";
import {
	claimViewPush,
	deliverNotificationPush,
	pushMessageFor,
	queueNotificationPush,
} from "@/lib/mobile-push";

beforeEach(() => {
	mocks.config = { keyId: "k", teamId: "t", privateKey: "p" };
	mocks.claims = new Set();
	mocks.claimAttempts = [];
	mocks.joinedSessions = 0;
	mocks.tokens = [{ token: "aa11", environment: "production" }];
	mocks.results = new Map([["aa11", "sent"]]);
	mocks.sent = [];
	mocks.deleted = [];
});

const deletedTokens = () =>
	mocks.deleted.filter((entry) => entry.table === schemaRef.mobilePushTokens);

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
		expect(mocks.claimAttempts).toHaveLength(0);
		expect(mocks.joinedSessions).toBe(1);
	});

	it("does nothing when APNs isn't configured", async () => {
		mocks.config = null;
		await deliverNotificationPush(comment);
		expect(mocks.sent).toHaveLength(0);
	});

	it("pushes one view per Cap per 10-minute window, however many viewers arrive", async () => {
		const view = { ...comment, type: "view" as const, content: undefined };
		await Promise.all([
			deliverNotificationPush(view),
			deliverNotificationPush(view),
			deliverNotificationPush({
				...view,
				type: "anon_view",
				anonName: "Otter",
			}),
		]);
		expect(mocks.claimAttempts).toHaveLength(3);
		expect(new Set(mocks.claimAttempts).size).toBe(1);
		expect(mocks.sent).toHaveLength(1);
	});

	it("claims a fresh window every 10 minutes and per Cap", async () => {
		const start = Date.UTC(2026, 10, 9, 12, 0, 0);
		const claim = (videoId: string, offsetMs: number) =>
			claimViewPush({ recipientId: "owner", videoId, now: start + offsetMs });
		expect(await claim("cap1", 0)).toBe(true);
		expect(await claim("cap1", 9 * 60 * 1000 + 59_000)).toBe(false);
		expect(await claim("cap1", 10 * 60 * 1000)).toBe(true);
		expect(await claim("cap2", 60_000)).toBe(true);
	});

	it("claims nothing when the recipient has no live tokens", async () => {
		mocks.tokens = [];
		await deliverNotificationPush({
			...comment,
			type: "view",
			content: undefined,
		});
		expect(mocks.claimAttempts).toHaveLength(0);
		expect(mocks.sent).toHaveLength(0);
	});

	it("sends the first anonymous view with the viewer's name", async () => {
		await deliverNotificationPush({
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
		expect(deletedTokens()).toHaveLength(1);
	});

	it("skips the delete when every token worked or no tokens exist", async () => {
		await deliverNotificationPush(comment);
		mocks.tokens = [];
		await deliverNotificationPush(comment);
		expect(deletedTokens()).toHaveLength(0);
		expect(mocks.sent).toHaveLength(1);
	});

	it("starts delivery outside a request scope without throwing", async () => {
		expect(() => queueNotificationPush(comment)).not.toThrow();
		await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
	});
});
