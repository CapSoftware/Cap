import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import { inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	statements: [] as Array<{ sql: string; params: unknown[] }>,
	user: null as { id: string; email: string; name: string } | null,
	anonymousId: null as string | null,
	rateLimited: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => fixture.user,
}));
vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-real-ip": "198.51.100.7" }),
	cookies: async () => ({
		get: (name: string) =>
			name === "cap-messenger-anon-id" && fixture.anonymousId
				? { value: fixture.anonymousId }
				: undefined,
		set: vi.fn(),
	}),
}));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: {
		MESSENGER_MESSAGE: "rl_messenger_message",
		MESSENGER_POLL: "rl_messenger_poll",
	},
	isRateLimited: async () => fixture.rateLimited,
}));
vi.mock("@/lib/messenger/agent", () => ({
	generateMessengerAgentReply: vi.fn(async () => "reply"),
}));
vi.mock("@/lib/messenger/supermemory", () => ({
	getIdentityTag: () => "tag",
	storeConversationInSupermemory: vi.fn(async () => undefined),
	syncCapKnowledgeBase: vi.fn(),
}));
vi.mock("@/lib/messenger/support-email", () => ({
	sendMessengerSupportEmail: vi.fn(),
}));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;
const writes = () =>
	fixture.statements.filter(({ sql }) =>
		/^\s*(update|insert|delete)\b/i.test(sql),
	);
const second = (offset: number) =>
	new Date(Date.UTC(2026, 10, 18, 12, 0, 0) + offset * 1000);

const seedConversation = async ({
	userId = null,
	anonymousId = null,
	mode = "agent",
	messages = 0,
	at = 0,
}: {
	userId?: string | null;
	anonymousId?: string | null;
	mode?: "agent" | "human";
	messages?: number;
	at?: number;
}) => {
	const conversationId = id();
	await database()
		.insert(Db.messengerConversations)
		.values({
			id: conversationId,
			agent: "Millie",
			mode,
			userId: userId as never,
			anonymousId,
			lastMessageAt: second(at + messages),
		});
	const rows = Array.from({ length: messages }, (_, index) => ({
		id: id(),
		conversationId,
		role: index % 2 === 0 ? ("user" as const) : ("agent" as const),
		content: `Message ${index} ${"x".repeat(200)}`,
		userId: null,
		anonymousId,
		createdAt: second(at + index),
	}));
	if (rows.length) await database().insert(Db.messengerMessages).values(rows);
	fixture.statements.length = 0;
	return { conversationId, messageIds: rows.map((row) => row.id) };
};

const pollRoute = async (
	conversationId: string,
	query: Record<string, string> = {},
) => {
	const { GET } = await import(
		"@/app/api/messenger/conversations/[id]/updates/route"
	);
	const url = new URL(
		`https://cap.so/api/messenger/conversations/${conversationId}/updates`,
	);
	for (const [key, value] of Object.entries(query))
		url.searchParams.set(key, value);
	const { NextRequest } = await import("next/server");
	const response = await GET(new NextRequest(url), {
		params: Promise.resolve({ id: conversationId }),
	});
	const body = await response.text();
	return {
		status: response.status,
		cacheControl: response.headers.get("cache-control"),
		bytes: Buffer.byteLength(body),
		json: body
			? (JSON.parse(body) as {
					mode: string;
					messages: Array<{ id: string; content: string }>;
				})
			: null,
	};
};

describe.runIf(Boolean(databaseUrl))("messenger poll against MySQL", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = createPool({ uri: databaseUrl, connectionLimit: 4 });
		fixture.database = drizzle(pool, {
			logger: {
				logQuery: (sql, params) => {
					fixture.statements.push({ sql, params });
				},
			},
		});
		const fillerAnonymousId = `filler-${id()}`;
		for (let batch = 0; batch < 4; batch++) {
			const { conversationId } = await seedConversation({
				anonymousId: fillerAnonymousId,
			});
			await database()
				.insert(Db.messengerMessages)
				.values(
					Array.from({ length: 500 }, (_, index) => ({
						id: id(),
						conversationId,
						role: "user" as const,
						content: "filler",
						userId: null,
						anonymousId: `${fillerAnonymousId}-${index}`,
						createdAt: second(index),
					})),
				);
		}
		await pool.query(
			"ANALYZE TABLE messenger_messages, messenger_conversations",
		);
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(() => {
		fixture.statements.length = 0;
		fixture.user = null;
		fixture.anonymousId = null;
		fixture.rateLimited = false;
	});

	describe("read path", () => {
		it("does not write when a signed-in viewer with an anonymous cookie polls", async () => {
			const anonymousId = `anon-${id()}`;
			const { conversationId } = await seedConversation({
				anonymousId,
				messages: 4,
			});
			fixture.user = { id: id(), email: "viewer@example.com", name: "Viewer" };
			fixture.anonymousId = anonymousId;
			const { fetchMessengerConversation } = await import(
				"@/actions/messenger"
			);
			for (let poll = 0; poll < 3; poll++) {
				const data = await fetchMessengerConversation(conversationId);
				expect(data.messages).toHaveLength(4);
			}
			expect(writes()).toEqual([]);
		});

		it("links anonymous conversations once, through their conversation ids", async () => {
			const anonymousId = `anon-${id()}`;
			const first = await seedConversation({ anonymousId, messages: 3 });
			const second = await seedConversation({ anonymousId, messages: 2 });
			const user = { id: id(), email: "linked@example.com", name: "Linked" };
			fixture.user = user;
			fixture.anonymousId = anonymousId;
			const { listViewerMessengerConversations } = await import(
				"@/lib/messenger/data"
			);

			const listed = await listViewerMessengerConversations();
			expect(listed.conversations.map((c) => c.id).sort()).toEqual(
				[first.conversationId, second.conversationId].sort(),
			);
			const messageUpdate = writes().find(({ sql }) =>
				/^update `messenger_messages`/i.test(sql),
			);
			if (!messageUpdate) throw new Error("Missing message link update");
			const [plan] = (await pool.query(
				`EXPLAIN ${messageUpdate.sql}`,
				messageUpdate.params,
			)) as unknown as [Array<{ type: string; key: string | null }>];
			expect(plan[0]).toMatchObject({
				type: "range",
				key: "conversation_created_at_idx",
			});

			const linkedMessages = await database()
				.select({ userId: Db.messengerMessages.userId })
				.from(Db.messengerMessages)
				.where(
					inArray(Db.messengerMessages.conversationId, [
						first.conversationId,
						second.conversationId,
					]),
				);
			expect(linkedMessages.map((row) => row.userId)).toEqual(
				Array(5).fill(user.id),
			);

			fixture.statements.length = 0;
			await listViewerMessengerConversations();
			expect(writes()).toEqual([]);
		});
	});

	describe("updates route", () => {
		it("answers 204 with no body when nothing is newer than the cursor", async () => {
			const anonymousId = `anon-${id()}`;
			fixture.anonymousId = anonymousId;
			const { conversationId, messageIds } = await seedConversation({
				anonymousId,
				messages: 30,
			});
			const result = await pollRoute(conversationId, {
				after: messageIds.at(-1) ?? "",
				mode: "agent",
			});
			expect(result.status).toBe(204);
			expect(result.bytes).toBe(0);
			expect(result.cacheControl).toBe("no-store");
			expect(writes()).toEqual([]);
		});

		it("returns only the messages after the cursor", async () => {
			const anonymousId = `anon-${id()}`;
			fixture.anonymousId = anonymousId;
			const { conversationId, messageIds } = await seedConversation({
				anonymousId,
				messages: 6,
			});
			const result = await pollRoute(conversationId, {
				after: messageIds[3] ?? "",
				mode: "agent",
			});
			expect(result.status).toBe(200);
			expect(result.cacheControl).toBe("no-store");
			expect(result.json?.messages.map((m) => m.id)).toEqual(
				messageIds.slice(4),
			);
		});

		it("does not skip messages that share the cursor's timestamp", async () => {
			const anonymousId = `anon-${id()}`;
			fixture.anonymousId = anonymousId;
			const { conversationId } = await seedConversation({ anonymousId });
			const sameSecond = ["a", "b", "c"].map((suffix) => ({
				id: `${id().slice(0, 14)}${suffix}`,
				conversationId,
				role: "admin" as const,
				content: suffix,
				userId: null,
				anonymousId,
				createdAt: second(5),
			}));
			await database().insert(Db.messengerMessages).values(sameSecond);
			fixture.statements.length = 0;
			const [first, middle, last] = sameSecond
				.map((row) => row.id)
				.sort((a, b) => (a < b ? -1 : 1));

			const all = await pollRoute(conversationId, { mode: "agent" });
			expect(all.json?.messages.map((m) => m.id)).toEqual([
				first,
				middle,
				last,
			]);
			const afterFirst = await pollRoute(conversationId, {
				after: first ?? "",
				mode: "agent",
			});
			expect(afterFirst.json?.messages.map((m) => m.id)).toEqual([
				middle,
				last,
			]);
			const afterMiddle = await pollRoute(conversationId, {
				after: middle ?? "",
				mode: "agent",
			});
			expect(afterMiddle.json?.messages.map((m) => m.id)).toEqual([
				first,
				last,
			]);
		});

		it("returns a message saved later in the cursor's second with a lower id", async () => {
			const anonymousId = `anon-${id()}`;
			fixture.anonymousId = anonymousId;
			const { conversationId } = await seedConversation({ anonymousId });
			const prefix = id().slice(0, 14);
			const row = (suffix: string) => ({
				id: `${prefix}${suffix}`,
				conversationId,
				role: "admin" as const,
				content: suffix,
				userId: null,
				anonymousId,
				createdAt: second(5),
			});
			await database().insert(Db.messengerMessages).values(row("m"));

			const before = await pollRoute(conversationId, {
				after: `${prefix}m`,
				mode: "agent",
			});
			expect(before.status).toBe(204);

			await database().insert(Db.messengerMessages).values(row("a"));
			const after = await pollRoute(conversationId, {
				after: `${prefix}m`,
				mode: "agent",
			});
			expect(after.status).toBe(200);
			expect(after.json?.messages.map((m) => m.id)).toEqual([`${prefix}a`]);
		});

		it("reports a handoff to a human even with no new messages", async () => {
			const anonymousId = `anon-${id()}`;
			fixture.anonymousId = anonymousId;
			const { conversationId, messageIds } = await seedConversation({
				anonymousId,
				mode: "human",
				messages: 2,
			});
			const result = await pollRoute(conversationId, {
				after: messageIds.at(-1) ?? "",
				mode: "agent",
			});
			expect(result.status).toBe(200);
			expect(result.json).toEqual({ mode: "human", messages: [] });
		});

		it("hides conversations the viewer does not own", async () => {
			const owner = { id: id(), email: "owner@example.com", name: "Owner" };
			const ownedByUser = await seedConversation({
				userId: owner.id,
				anonymousId: "shared-cookie",
				messages: 2,
			});
			const ownedByAnonymous = await seedConversation({
				anonymousId: `anon-${id()}`,
				messages: 2,
			});

			fixture.anonymousId = `anon-${id()}`;
			expect((await pollRoute(ownedByAnonymous.conversationId)).status).toBe(
				404,
			);
			expect((await pollRoute(ownedByUser.conversationId)).status).toBe(404);
			expect((await pollRoute("missingconversa")).status).toBe(404);

			fixture.anonymousId = "shared-cookie";
			fixture.user = { id: id(), email: "other@example.com", name: "Other" };
			expect((await pollRoute(ownedByUser.conversationId)).status).toBe(404);

			fixture.user = null;
			expect((await pollRoute(ownedByUser.conversationId)).status).toBe(200);

			fixture.user = owner;
			fixture.anonymousId = null;
			expect((await pollRoute(ownedByUser.conversationId)).status).toBe(200);
		});

		it("keeps the admin rules of the visitor chat: admins see only their own", async () => {
			const admin = { id: id(), email: MESSENGER_ADMIN_EMAIL, name: "Admin" };
			const visitor = await seedConversation({
				anonymousId: `anon-${id()}`,
				messages: 1,
			});
			const own = await seedConversation({ userId: admin.id, messages: 1 });
			fixture.user = admin;
			expect((await pollRoute(visitor.conversationId)).status).toBe(404);
			expect((await pollRoute(own.conversationId)).status).toBe(200);
		});

		it("lets a signed-in viewer poll an unlinked conversation from their cookie", async () => {
			const anonymousId = `anon-${id()}`;
			const { conversationId } = await seedConversation({
				anonymousId,
				messages: 1,
			});
			fixture.user = { id: id(), email: "new@example.com", name: "New" };
			fixture.anonymousId = anonymousId;
			expect((await pollRoute(conversationId)).status).toBe(200);
			expect(writes()).toEqual([]);
		});

		it("answers 429 when the poll rate limit is hit", async () => {
			const anonymousId = `anon-${id()}`;
			fixture.anonymousId = anonymousId;
			const { conversationId } = await seedConversation({ anonymousId });
			fixture.rateLimited = true;
			const result = await pollRoute(conversationId);
			expect(result.status).toBe(429);
			expect(fixture.statements).toEqual([]);
		});
	});

	it("costs fewer statements and bytes per idle poll than the full reload", async () => {
		const anonymousId = `anon-${id()}`;
		const { conversationId, messageIds } = await seedConversation({
			anonymousId,
			messages: 30,
		});
		fixture.user = { id: id(), email: "cost@example.com", name: "Cost" };
		fixture.anonymousId = anonymousId;

		const { fetchMessengerConversation } = await import("@/actions/messenger");
		const full = await fetchMessengerConversation(conversationId);
		const fullStatements = fixture.statements.length;
		const fullWrites = writes().length;
		const fullBytes = Buffer.byteLength(JSON.stringify(full));
		console.info(
			`messenger full reload, 30 message conversation, signed-in viewer with anonymous cookie: ${fullStatements} statements (${fullWrites} writes), ${fullBytes} bytes`,
		);

		fixture.statements.length = 0;
		const idle = await pollRoute(conversationId, {
			after: messageIds.at(-1) ?? "",
			mode: "agent",
		});
		const idleStatements = fixture.statements.length;

		console.info(
			`messenger idle updates poll, same conversation: ${idleStatements} statements (${writes().length} writes), ${idle.bytes} bytes, status ${idle.status}`,
		);
		const plans: string[] = [];
		for (const statement of fixture.statements) {
			const [plan] = (await pool.query(
				`EXPLAIN ${statement.sql}`,
				statement.params,
			)) as unknown as [
				Array<{ table: string; type: string; key: string | null }>,
			];
			for (const row of plan) {
				plans.push(`${row.table} ${row.type} ${row.key}`);
				expect(row.type).not.toBe("ALL");
				expect(row.type).not.toBe("index");
			}
		}
		console.info(`messenger idle updates poll plans: ${plans.join(", ")}`);
		expect(idle.status).toBe(204);
		expect(idleStatements).toBeLessThanOrEqual(2);
		expect(writes()).toEqual([]);
		expect(idle.bytes).toBe(0);
	});
});
