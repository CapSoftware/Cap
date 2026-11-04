import {
	messengerConversations,
	messengerMessages,
} from "@cap/database/schema";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Viewer = { id: string; name: string; email: string } | null;

const LIMIT = 3;

const mocks = vi.hoisted(() => ({
	state: {
		conversations: [] as Record<string, unknown>[],
		messages: [] as Record<string, unknown>[],
		ip: "198.51.100.1" as string | null,
		user: null as { id: string; name: string; email: string } | null,
		anonymousId: null as string | null,
		mintedAnonymousIds: 0,
		buckets: new Map<string, number>(),
	},
	agentReply: vi.fn(async () => "agent reply"),
	storeConversation: vi.fn(async () => undefined),
	sendSupportEmail: vi.fn(async () => ({ status: "sent" })),
	linkAnonymous: vi.fn(async () => undefined),
	isRateLimited: vi.fn(),
}));

const dialect = new MySqlDialect();
const tableRows = (table: unknown) =>
	table === messengerConversations
		? mocks.state.conversations
		: table === messengerMessages
			? mocks.state.messages
			: [];

const matcher = (condition: SQL | undefined) => {
	if (!condition) return () => true;
	const { sql, params } = dialect.sqlToQuery(condition);
	const match = sql.match(/^`\w+`\.`(\w+)` = \?$/);
	if (!match?.[1]) throw new Error(`Unsupported condition ${sql}`);
	const column = match[1];
	return (row: Row) => row[column] === params[0];
};

const sortRows = (rows: Row[], order: SQL | undefined) => {
	if (!order) return rows;
	const { sql } = dialect.sqlToQuery(order);
	const match = sql.match(/^`\w+`\.`(\w+)`( desc| asc)?$/);
	if (!match?.[1]) throw new Error(`Unsupported order ${sql}`);
	const column = match[1];
	const direction = match[2] === " desc" ? -1 : 1;
	return rows
		.map((row, index) => ({ row, index }))
		.sort(
			(a, b) =>
				direction *
				((a.row[column] as Date).getTime() -
					(b.row[column] as Date).getTime() || a.index - b.index),
		)
		.map(({ row }) => row);
};

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => {
				let condition: SQL | undefined;
				let order: SQL | undefined;
				let limit: number | undefined;
				const run = () => {
					const rows = sortRows(
						tableRows(table).filter(matcher(condition)),
						order,
					);
					return limit === undefined ? rows : rows.slice(0, limit);
				};
				const query = Object.assign(Promise.resolve().then(run), {
					where: (value: SQL) => {
						condition = value;
						return query;
					},
					orderBy: (value: SQL) => {
						order = value;
						return query;
					},
					limit: (value: number) => {
						limit = value;
						return query;
					},
				});
				return query;
			},
		}),
		insert: (table: unknown) => ({
			values: async (row: Row) => {
				tableRows(table).push({ ...row });
			},
		}),
		update: (table: unknown) => ({
			set: (values: Row) => ({
				where: async (condition: SQL) => {
					for (const row of tableRows(table).filter(matcher(condition))) {
						Object.assign(row, values);
					}
				},
			}),
		}),
	}),
}));
vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
	headers: async () =>
		new Headers(mocks.state.ip ? { "x-real-ip": mocks.state.ip } : {}),
}));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { MESSENGER_MESSAGE: "rl_messenger_message" },
	isRateLimited: mocks.isRateLimited,
}));
vi.mock("@/lib/messenger/agent", () => ({
	generateMessengerAgentReply: mocks.agentReply,
}));
vi.mock("@/lib/messenger/supermemory", () => ({
	getIdentityTag: (userId: string | null, anonymousId: string | null) =>
		userId ? `user:${userId}` : `anon:${anonymousId}`,
	storeConversationInSupermemory: mocks.storeConversation,
	syncCapKnowledgeBase: vi.fn(),
}));
vi.mock("@/lib/messenger/support-email", () => ({
	sendMessengerSupportEmail: mocks.sendSupportEmail,
}));
vi.mock("@/lib/messenger/data", () => ({
	getViewerContext: async () => ({
		user: mocks.state.user,
		anonymousId: mocks.state.anonymousId,
		isAdmin: false,
	}),
	getOrCreateAnonymousId: async () => {
		if (mocks.state.anonymousId) return mocks.state.anonymousId;
		mocks.state.mintedAnonymousIds += 1;
		mocks.state.anonymousId = `anon-${mocks.state.mintedAnonymousIds}`;
		return mocks.state.anonymousId;
	},
	linkAnonymousConversationsToUser: mocks.linkAnonymous,
	getMessengerConversationForViewer: vi.fn(),
	listAdminMessengerConversations: vi.fn(),
	listViewerMessengerConversations: vi.fn(),
	requireAdminViewer: vi.fn(),
}));

import {
	createMessengerConversation,
	sendMessengerUserMessage,
} from "@/actions/messenger";

const visitAs = ({
	ip,
	user = null,
	anonymousId = null,
}: {
	ip: string | null;
	user?: Viewer;
	anonymousId?: string | null;
}) => {
	mocks.state.ip = ip;
	mocks.state.user = user;
	mocks.state.anonymousId = anonymousId;
};

const seedConversation = (row: Row) => {
	mocks.state.conversations.push({
		agent: "Millie",
		mode: "agent",
		userId: null,
		anonymousId: null,
		createdAt: new Date(0),
		lastMessageAt: new Date(0),
		...row,
	});
};

const countRows = () => ({
	conversations: mocks.state.conversations.length,
	messages: mocks.state.messages.length,
});

beforeEach(() => {
	mocks.state.conversations = [];
	mocks.state.messages = [];
	mocks.state.mintedAnonymousIds = 0;
	mocks.state.buckets = new Map();
	visitAs({ ip: "198.51.100.1" });
	mocks.isRateLimited.mockImplementation(
		async (ruleId: string, opts?: { key?: string; headers?: Headers }) => {
			const bucket = `${ruleId}:${
				opts?.key ?? opts?.headers?.get("x-real-ip") ?? "no-ip"
			}`;
			const count = (mocks.state.buckets.get(bucket) ?? 0) + 1;
			mocks.state.buckets.set(bucket, count);
			return count > LIMIT;
		},
	);
});

describe("messenger message limits", () => {
	it("stops replying once one visitor passes the limit and keeps serving other visitors", async () => {
		visitAs({ ip: "198.51.100.1", anonymousId: "anon-a" });
		const conversationId = await createMessengerConversation();

		const results = [];
		for (let index = 1; index < LIMIT; index++) {
			results.push(
				await sendMessengerUserMessage({ conversationId, content: "hi" }),
			);
		}
		expect(results).toEqual(
			Array.from({ length: LIMIT - 1 }, () => ({ mode: "agent" })),
		);
		expect(mocks.agentReply).toHaveBeenCalledTimes(LIMIT - 1);

		const rowsBefore = countRows();
		mocks.agentReply.mockClear();
		mocks.storeConversation.mockClear();

		const limited = await sendMessengerUserMessage({
			conversationId,
			content: "hi",
		});

		expect(limited).toEqual({ error: expect.any(String) });
		expect(mocks.agentReply).not.toHaveBeenCalled();
		expect(mocks.storeConversation).not.toHaveBeenCalled();
		expect(countRows()).toEqual(rowsBefore);

		visitAs({ ip: "203.0.113.7", anonymousId: "anon-b" });
		const otherConversation = await createMessengerConversation();
		await expect(
			sendMessengerUserMessage({
				conversationId: otherConversation,
				content: "hello",
			}),
		).resolves.toEqual({ mode: "agent" });
		expect(mocks.agentReply).toHaveBeenCalledTimes(1);
	});

	it("counts every call from one address even when the visitor cookie changes", async () => {
		for (let index = 0; index < LIMIT; index++) {
			visitAs({ ip: "198.51.100.1", anonymousId: null });
			await createMessengerConversation();
		}

		visitAs({ ip: "198.51.100.1", anonymousId: null });
		const rowsBefore = countRows();
		await expect(createMessengerConversation()).rejects.toThrow(/too quickly/i);
		expect(countRows()).toEqual(rowsBefore);

		visitAs({ ip: "198.51.100.1", anonymousId: "fresh-cookie" });
		seedConversation({ id: "fresh-conversation", anonymousId: "fresh-cookie" });
		await expect(
			sendMessengerUserMessage({
				conversationId: "fresh-conversation",
				content: "hi",
			}),
		).resolves.toEqual({ error: expect.any(String) });
		expect(mocks.agentReply).not.toHaveBeenCalled();
	});

	it("limits a signed-in user across addresses", async () => {
		const user = { id: "user-1", name: "User", email: "user@example.com" };
		seedConversation({ id: "user-conversation", userId: user.id });

		for (let index = 0; index < LIMIT; index++) {
			visitAs({ ip: `198.51.100.${index + 10}`, user });
			await expect(
				sendMessengerUserMessage({
					conversationId: "user-conversation",
					content: "hi",
				}),
			).resolves.toEqual({ mode: "agent" });
		}

		visitAs({ ip: "198.51.100.99", user });
		await expect(
			sendMessengerUserMessage({
				conversationId: "user-conversation",
				content: "hi",
			}),
		).resolves.toEqual({ error: expect.any(String) });
		expect(mocks.agentReply).toHaveBeenCalledTimes(LIMIT);
		expect(mocks.isRateLimited).toHaveBeenCalledWith(
			"rl_messenger_message",
			expect.objectContaining({ key: expect.stringContaining(user.id) }),
		);
	});

	it("checks the limit before reading the conversation or linking visitor history", async () => {
		const user = { id: "user-2", name: "User", email: "user2@example.com" };
		mocks.isRateLimited.mockResolvedValue(true);
		visitAs({ ip: "198.51.100.1", user, anonymousId: "anon-link" });

		await expect(
			sendMessengerUserMessage({ conversationId: "missing", content: "hi" }),
		).resolves.toEqual({ error: expect.any(String) });
		await expect(createMessengerConversation()).rejects.toThrow(/too quickly/i);
		expect(mocks.linkAnonymous).not.toHaveBeenCalled();
		expect(countRows()).toEqual({ conversations: 0, messages: 0 });
	});

	it("keeps ownership checks and human takeover under the limit", async () => {
		seedConversation({ id: "someone-else", anonymousId: "anon-owner" });
		visitAs({ ip: "198.51.100.1", anonymousId: "anon-intruder" });
		await expect(
			sendMessengerUserMessage({
				conversationId: "someone-else",
				content: "hi",
			}),
		).rejects.toThrow("Unauthorized");

		seedConversation({ id: "human", anonymousId: "anon-human", mode: "human" });
		visitAs({ ip: "203.0.113.9", anonymousId: "anon-human" });
		await expect(
			sendMessengerUserMessage({ conversationId: "human", content: "hi" }),
		).resolves.toEqual({ mode: "human" });
		expect(mocks.agentReply).not.toHaveBeenCalled();

		const user = { id: "user-3", name: "User", email: "user3@example.com" };
		seedConversation({ id: "anon-thread", anonymousId: "anon-c" });
		visitAs({ ip: "203.0.113.10", user, anonymousId: "anon-c" });
		await expect(
			sendMessengerUserMessage({
				conversationId: "anon-thread",
				content: "hi",
			}),
		).resolves.toEqual({ mode: "agent" });
		expect(
			mocks.state.conversations.find((row) => row.id === "anon-thread")?.userId,
		).toBe(user.id);
		expect(mocks.linkAnonymous).toHaveBeenCalledWith({
			userId: user.id,
			anonymousId: "anon-c",
		});
	});

	it("sends only the most recent part of a long thread to memory", async () => {
		seedConversation({ id: "long", anonymousId: "anon-long" });
		const start = Date.UTC(2026, 0, 1);
		for (let index = 0; index < 300; index++) {
			mocks.state.messages.push({
				id: `seed-${index}`,
				conversationId: "long",
				role: index % 2 === 0 ? "user" : "agent",
				content: `message ${index}`,
				userId: null,
				anonymousId: "anon-long",
				createdAt: new Date(start + index * 1000),
			});
		}
		visitAs({ ip: "198.51.100.1", anonymousId: "anon-long" });

		await sendMessengerUserMessage({ conversationId: "long", content: "hi" });

		const calls = mocks.storeConversation.mock.calls as unknown as Array<
			[{ messages: Array<{ content: string; timestamp: string }> }]
		>;
		const sent = calls.at(-1)?.[0].messages ?? [];
		expect(sent.length).toBeGreaterThan(20);
		expect(sent.length).toBeLessThanOrEqual(50);
		expect(sent.at(-1)?.content).toBe("agent reply");
		expect(sent.at(-2)?.content).toBe("hi");
		const timestamps = sent.map((message) => Date.parse(message.timestamp));
		expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
		const history = (
			mocks.agentReply.mock.calls as unknown as Array<[{ history: unknown[] }]>
		)[0]?.[0].history;
		expect(history).toHaveLength(301);
	});
});
