import * as Db from "@cap/database/schema";
import type { DbClient } from "@cap/web-backend";
import type { SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const INVITE_LIMIT = 3;

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	sendEmail: vi.fn(),
	limitChecks: [] as Array<{ ruleId: string; key?: string }>,
	limitCounts: new Map<string, number>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: mocks.db,
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: mocks.sendEmail,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: async (ruleId: string, opts?: { key?: string }) => {
		mocks.limitChecks.push({ ruleId, key: opts?.key });
		const bucket = `${ruleId}|${opts?.key ?? "ip"}`;
		const count = (mocks.limitCounts.get(bucket) ?? 0) + 1;
		mocks.limitCounts.set(bucket, count);
		return count > INVITE_LIMIT;
	},
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
	const idempotency: Row[] = [];
	const invites: Row[] = [];
	const client = {
		select: (fields?: Record<string, unknown>) => {
			let table: MySqlTable;
			let condition: SQL | undefined;
			const rows = () => {
				if (table === Db.agentApiKeys) {
					return [
						{
							id: "user_one",
							email: "owner@example.com",
							activeOrganizationId: "org_one",
							tokenId: "token_one",
							scopes: ["caps:read", "organizations:members"],
							expiresAt: new Date(Date.now() + 60_000),
							revokedAt: null,
							lastUsedAt: new Date(),
						},
					];
				}
				if (table === Db.organizationMembers) {
					if (fields && Object.keys(fields).length === 1) return [];
					return [{ id: "member_one", role: "owner", hasProSeat: false }];
				}
				if (table === Db.organizationInvites) return invites;
				if (table === Db.organizations) return [{ name: "Team" }];
				if (table === Db.agentApiIdempotency) {
					return idempotency.filter((row) => matches(condition, row));
				}
				throw new Error("Unexpected table");
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
				orderBy: () => query,
				limit: () =>
					Object.assign(Promise.resolve().then(rows), {
						for: async () => rows(),
					}),
			};
			return query;
		},
		insert: (table: MySqlTable) => ({
			values: (value: Row) => {
				if (table === Db.organizationInvites) {
					invites.push(value);
				} else if (table === Db.agentApiIdempotency) {
					if (
						!idempotency.some(
							(row) =>
								row.userId === value.userId &&
								row.operation === value.operation &&
								row.keyHash === value.keyHash,
						)
					)
						idempotency.push({ state: "pending", ...value });
				} else {
					throw new Error("Unexpected insert");
				}
				return Object.assign(Promise.resolve(), {
					onDuplicateKeyUpdate: async () => {},
				});
			},
		}),
		update: (table: MySqlTable) => ({
			set: (patch: Row) => ({
				where: async (condition: SQL | undefined) => {
					const rows = (
						table === Db.organizationInvites ? invites : idempotency
					).filter((row) => matches(condition, row));
					for (const row of rows) Object.assign(row, patch);
					return [{ affectedRows: rows.length }];
				},
			}),
		}),
		delete: (table: MySqlTable) => ({
			where: async (condition: SQL | undefined) => {
				if (table !== Db.agentApiIdempotency) {
					throw new Error("Unexpected delete");
				}
				for (const row of idempotency.filter((value) =>
					matches(condition, value),
				)) {
					idempotency.splice(idempotency.indexOf(row), 1);
				}
				return [{ affectedRows: 1 }];
			},
		}),
		transaction: <T>(callback: (tx: DbClient) => Promise<T>) =>
			callback(client as unknown as DbClient),
	};
	return { client, invites };
}

describe("agent organization invite limits", () => {
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
		mocks.sendEmail.mockReset();
		mocks.sendEmail.mockResolvedValue({ data: { id: "email" }, error: null });
		mocks.limitChecks = [];
		mocks.limitCounts = new Map();
	});

	const invite = (key: string, body: Record<string, unknown> = {}) =>
		POST(
			new Request("http://localhost/api/v1/organizations/org_one/invites", {
				method: "POST",
				headers: {
					Authorization: `Bearer cap_cli_${"a".repeat(43)}`,
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify({ email: "invitee@example.com", ...body }),
			}),
		);

	it("stops sending invite emails once the organization or sender reaches the limit", async () => {
		const statuses = [];
		for (let index = 0; index < INVITE_LIMIT + 2; index += 1) {
			statuses.push((await invite(`invite-key-${index}`)).status);
		}

		expect(statuses).toEqual([200, 200, 200, 429, 429]);
		expect(mocks.sendEmail).toHaveBeenCalledTimes(INVITE_LIMIT);
		expect(new Set(mocks.limitChecks.map(({ key }) => key))).toEqual(
			new Set([
				"organization-invite:organization:org_one",
				"organization-invite:user:user_one",
			]),
		);
		expect(
			mocks.limitChecks.every(
				({ ruleId }) => ruleId === "rl_organization_invite",
			),
		).toBe(true);
		const limited = await invite("invite-key-limited");
		expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
	});

	it("does not count invites created without an email", async () => {
		for (let index = 0; index < INVITE_LIMIT + 2; index += 1) {
			const response = await invite(`quiet-key-${index}`, {
				sendEmail: false,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				emailDelivery: "not_requested",
			});
		}
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(mocks.limitChecks).toEqual([]);
	});

	it("replays a delivered invite without another email or limit check", async () => {
		const first = await invite("replayed-key");
		expect(first.status).toBe(200);
		const body = await first.json();
		const checks = mocks.limitChecks.length;

		const replay = await invite("replayed-key");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(body);
		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
		expect(mocks.limitChecks).toHaveLength(checks);
	});

	it("sends a limited invite when it is retried with the same key later", async () => {
		mocks.limitCounts.set(
			"rl_organization_invite|organization-invite:user:user_one",
			INVITE_LIMIT,
		);
		expect((await invite("retried-key")).status).toBe(429);
		expect(mocks.sendEmail).not.toHaveBeenCalled();

		mocks.limitCounts = new Map();
		const retry = await invite("retried-key");
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ emailDelivery: "accepted" });
		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
		expect(database.invites).toHaveLength(1);
	});
});
