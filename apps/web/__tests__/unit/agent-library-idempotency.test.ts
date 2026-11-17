import * as Db from "@cap/database/schema";
import type { DbClient } from "@cap/web-backend";
import type { SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	userId: "user_one",
	scopes: ["caps:read", "library:write"],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: mocks.db,
}));

type Row = Record<string, unknown>;

function matches(condition: SQL | undefined, row: Row) {
	if (!condition) return true;
	const query = new MySqlDialect().sqlToQuery(condition);
	let parameterIndex = 0;
	return query.sql
		.replaceAll("(", "")
		.replaceAll(")", "")
		.split(" and ")
		.every((clause) => {
			const match = /^`[^`]+`\.`([^`]+)` = \?$/.exec(clause);
			if (!match?.[1]) throw new Error(`Unexpected predicate: ${clause}`);
			return row[match[1]] === query.params[parameterIndex++];
		});
}

function makeDatabase() {
	const tables = new Map<MySqlTable, Row[]>([
		[Db.agentApiIdempotency, []],
		[Db.folders, []],
		[Db.spaces, []],
		[Db.spaceMembers, []],
	]);
	const rowsFor = (table: MySqlTable) => {
		const rows = tables.get(table);
		if (!rows) throw new Error("Unexpected table");
		return rows;
	};
	const client = {
		select: (fields?: Record<string, unknown>) => {
			let table: MySqlTable;
			let condition: SQL | undefined;
			const rows = () => {
				if (table === Db.agentApiKeys) {
					return [
						{
							id: mocks.userId,
							email: "test@example.com",
							activeOrganizationId: "org_one",
							tokenId: "token_one",
							scopes: mocks.scopes,
							expiresAt: new Date(Date.now() + 60_000),
							revokedAt: null,
							lastUsedAt: new Date(),
						},
					];
				}
				if (table === Db.organizationMembers) {
					return fields && "ownerId" in fields
						? [
								{
									id: "org_one",
									name: "Team",
									ownerId: mocks.userId,
									role: "owner",
									hasProSeat: false,
									ownerSubscriptionStatus: null,
									ownerThirdPartySubscriptionId: null,
									createdAt: new Date(0),
									updatedAt: new Date(0),
								},
							]
						: [{ id: "member_one", role: "owner", hasProSeat: false }];
				}
				return rowsFor(table).filter((row) => matches(condition, row));
			};
			const query = {
				from: (value: MySqlTable) => {
					table = value;
					return query;
				},
				innerJoin: () => query,
				where: (value: SQL | undefined) => {
					condition = value;
					return query;
				},
				limit: () =>
					Object.assign(Promise.resolve(rows()), {
						for: async () => rows(),
					}),
				orderBy: async () => rows(),
			};
			return query;
		},
		insert: (table: MySqlTable) => ({
			values: (value: Row) => {
				if (
					table !== Db.agentApiIdempotency ||
					!rowsFor(table).some(
						(row) =>
							row.userId === value.userId &&
							row.operation === value.operation &&
							row.keyHash === value.keyHash,
					)
				)
					rowsFor(table).push({ state: "pending", ...value });
				return Object.assign(Promise.resolve(), {
					onDuplicateKeyUpdate: async () => {},
				});
			},
		}),
		update: (table: MySqlTable) => ({
			set: (patch: Row) => ({
				where: async (condition: SQL | undefined) => {
					const rows = rowsFor(table).filter((row) => matches(condition, row));
					for (const row of rows) Object.assign(row, patch);
					return [{ affectedRows: rows.length }];
				},
			}),
		}),
		transaction: <T>(callback: (tx: DbClient) => Promise<T>) =>
			callback(client as unknown as DbClient),
	};
	return { client, rowsFor };
}

describe("agent library creation idempotency", () => {
	let POST: typeof import("@/app/api/v1/[...route]/route").POST;
	let database: ReturnType<typeof makeDatabase>;

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			NODE_ENV: "test",
		});
		({ POST } = await import("@/app/api/v1/[...route]/route"));
	});

	beforeEach(() => {
		database = makeDatabase();
		mocks.db.mockReturnValue(database.client);
		mocks.userId = "user_one";
		mocks.scopes = ["caps:read", "library:write"];
	});

	const request = (kind: string, name = "Planning", key = "library-key-one") =>
		POST(
			new Request(`http://localhost/api/v1/organizations/org_one/${kind}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer cap_cli_${"a".repeat(43)}`,
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify({ name }),
			}),
		);

	for (const [kind, table] of [
		["folders", Db.folders],
		["spaces", Db.spaces],
	] as const) {
		it(`replays ${kind} without creating another resource`, async () => {
			const first = await request(kind);
			expect(first.status).toBe(200);
			const body = await first.json();
			const replay = await request(kind);
			expect(replay.status).toBe(200);
			expect(await replay.json()).toEqual(body);
			expect(database.rowsFor(table)).toHaveLength(1);
			if (kind === "spaces")
				expect(database.rowsFor(Db.spaceMembers)).toHaveLength(1);
		});

		it(`rejects a changed ${kind} payload before writing`, async () => {
			expect((await request(kind)).status).toBe(200);
			const conflict = await request(kind, "Different");
			expect(conflict.status).toBe(409);
			expect(await conflict.json()).toMatchObject({
				code: "IDEMPOTENCY_CONFLICT",
			});
			expect(database.rowsFor(table)).toHaveLength(1);
		});

		it(`allows another user to reuse the ${kind} key`, async () => {
			expect((await request(kind)).status).toBe(200);
			mocks.userId = "user_two";
			expect((await request(kind, "Other user's resource")).status).toBe(200);
			expect(database.rowsFor(table)).toHaveLength(2);
			expect(database.rowsFor(table).map((row) => row.createdById)).toEqual([
				"user_one",
				"user_two",
			]);
		});

		it(`checks scope before replaying ${kind}`, async () => {
			expect((await request(kind)).status).toBe(200);
			mocks.scopes = ["caps:read"];
			expect((await request(kind)).status).toBe(403);
			expect(database.rowsFor(table)).toHaveLength(1);
		});
	}
});
