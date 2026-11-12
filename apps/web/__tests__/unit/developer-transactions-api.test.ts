import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredRow = {
	id: string;
	accountId: string;
	type: string;
	amountMicroCredits: number;
	balanceAfterMicroCredits: number;
	referenceId: string | null;
	referenceType: string | null;
	metadata: unknown;
	createdAt: Date;
};

const mocks = vi.hoisted(() => ({
	keys: {} as Record<string, string>,
	accounts: [] as { id: string; appId: string }[],
	rows: [] as StoredRow[],
	queries: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const dialect = new MySqlDialect();
	const asTime = (value: unknown) =>
		value instanceof Date
			? value.getTime()
			: new Date(`${String(value).replace(" ", "T")}Z`).getTime();

	const select = (fields?: Record<string, unknown>) => {
		let table: unknown = null;
		let condition: SQL | undefined;
		let limit = Number.POSITIVE_INFINITY;
		let offset = 0;
		const run = async () => {
			const rendered = condition
				? dialect.sqlToQuery(condition)
				: { sql: "", params: [] as unknown[] };
			if (table === schema.developerApiKeys) {
				const appId = mocks.keys[String(rendered.params[0])];
				return appId ? [{ appId }] : [];
			}
			if (table !== schema.developerCreditTransactions) return [];
			mocks.queries.push(rendered);
			const [appId, ...cursor] = rendered.params;
			const accountIds = mocks.accounts
				.filter((account) => account.appId === appId)
				.map((account) => account.id);
			let rows = mocks.rows
				.filter((row) => accountIds.includes(row.accountId))
				.sort(
					(a, b) =>
						b.createdAt.getTime() - a.createdAt.getTime() ||
						(a.id < b.id ? 1 : -1),
				);
			if (cursor.length > 0) {
				const time = asTime(cursor[0]);
				const id = String(cursor.at(-1));
				rows = rows.filter(
					(row) =>
						row.createdAt.getTime() < time ||
						(row.createdAt.getTime() === time && row.id < id),
				);
			}
			if (fields && "total" in fields) return [{ total: rows.length }];
			return rows.slice(offset, offset + limit);
		};
		const query = {
			from(next: unknown) {
				table = next;
				return query;
			},
			innerJoin: () => query,
			where(next: SQL | undefined) {
				condition = next;
				const rows = Promise.resolve().then(run);
				const result = Object.assign(rows, {
					orderBy: () => result,
					limit(value: number) {
						limit = value;
						return result;
					},
					offset(value: number) {
						offset = value;
						return result;
					},
				});
				return result;
			},
		};
		return query;
	};
	const update = () => ({
		set: () => ({ where: () => Promise.resolve() }),
	});
	return { db: () => ({ select, update }) };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({
		WEB_URL: "https://cap.so",
		NEXTAUTH_SECRET: "unit-test-signing-secret",
	}),
}));
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/developer-video-start", () => ({
	redriveDeveloperVideoProcessing: vi.fn(),
}));
vi.mock("@/lib/infra-video-upload", () => ({
	MAX_UPLOAD_BYTES: 36_000_000_000,
	openUpload: vi.fn(),
	createInfraVideo: vi.fn(),
	initiateInfraUpload: vi.fn(),
	presignInfraUploadParts: vi.fn(),
	completeInfraUpload: vi.fn(),
	abortInfraUpload: vi.fn(),
}));

import * as rest from "@/app/api/developer/v1/[...route]/route";
import { developerOpenApiSpec } from "@/lib/developer-openapi";
import { readAppLedger } from "@/lib/infra-ledger-store";

let serial = 0;
const newKey = (appId: string) => {
	const key = `csk_ledger_${++serial}`;
	mocks.keys[`hash:${key}`] = appId;
	return key;
};

const get = (path: string, key?: string) =>
	rest.GET(
		new Request(`https://cap.so/api/developer/v1${path}`, {
			headers: key ? { Authorization: `Bearer ${key}` } : {},
		}),
	) as Promise<Response>;

const store = (
	accountId: string,
	count: number,
	startAt = "2026-11-01T00:00:00Z",
	prefix = accountId,
) => {
	let balance = 0;
	for (let index = 0; index < count; index++) {
		const amount = index === 0 ? 2_500_000 : -33;
		balance += amount;
		mocks.rows.push({
			id: `${prefix}-${String(index).padStart(4, "0")}`,
			accountId,
			type: index === 0 ? "topup" : "transcription",
			amountMicroCredits: amount,
			balanceAfterMicroCredits: balance,
			referenceId: index === 0 ? "pi_3TestPayment" : `transcript-${index}`,
			referenceType:
				index === 0 ? "stripe_payment_intent" : "developer_transcript",
			metadata: { internal: "never shown" },
			createdAt: new Date(Date.parse(startAt) + index * 60_000),
		});
	}
};

beforeEach(() => {
	mocks.keys = {};
	mocks.accounts = [
		{ id: "account-a", appId: "app-a" },
		{ id: "account-b", appId: "app-b" },
	];
	mocks.rows = [];
	mocks.queries = [];
});

describe("GET /transactions", () => {
	it("asks for a secret key", async () => {
		const missing = await get("/transactions");
		const publicKey = await get("/transactions", "cpk_public_key");
		const unknown = await get("/transactions", "csk_not_a_key");

		for (const response of [missing, publicKey, unknown]) {
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				code: "invalid_secret_key",
				hint: expect.any(String),
				docs: expect.any(String),
			});
		}
		expect(mocks.queries).toHaveLength(0);
	});

	it("returns the newest rows first with exact dollars and a reference", async () => {
		store("account-a", 3);

		const response = await get("/transactions", newKey("app-a"));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.pagination).toEqual({ limit: 50, offset: 0, hasMore: false });
		expect(body.data).toEqual([
			{
				id: "account-a-0002",
				type: "transcription",
				description: "Transcription",
				note: null,
				amountMicroCredits: -33,
				amountDollars: "-0.00033",
				balanceAfterMicroCredits: 2_499_934,
				balanceAfterDollars: "24.99934",
				referenceType: "developer_transcript",
				referenceId: "transcript-2",
				createdAt: "2026-11-01T00:02:00.000Z",
			},
			{
				id: "account-a-0001",
				type: "transcription",
				description: "Transcription",
				note: null,
				amountMicroCredits: -33,
				amountDollars: "-0.00033",
				balanceAfterMicroCredits: 2_499_967,
				balanceAfterDollars: "24.99967",
				referenceType: "developer_transcript",
				referenceId: "transcript-1",
				createdAt: "2026-11-01T00:01:00.000Z",
			},
			{
				id: "account-a-0000",
				type: "topup",
				description: "Top-up",
				note: null,
				amountMicroCredits: 2_500_000,
				amountDollars: "25.00",
				balanceAfterMicroCredits: 2_500_000,
				balanceAfterDollars: "25.00",
				referenceType: "stripe_payment_intent",
				referenceId: "pi_3TestPayment",
				createdAt: "2026-11-01T00:00:00.000Z",
			},
		]);
		expect(JSON.stringify(body)).not.toContain("never shown");
	});

	it("pages with limit and offset the way transcripts do", async () => {
		store("account-a", 120);
		const key = newKey("app-a");

		const seen: string[] = [];
		const pages: { limit: number; offset: number; hasMore: boolean }[] = [];
		for (const offset of [0, 50, 100]) {
			const body = await (
				await get(`/transactions?offset=${offset}`, key)
			).json();
			pages.push(body.pagination);
			seen.push(...body.data.map((entry: { id: string }) => entry.id));
		}

		expect(pages).toEqual([
			{ limit: 50, offset: 0, hasMore: true },
			{ limit: 50, offset: 50, hasMore: true },
			{ limit: 50, offset: 100, hasMore: false },
		]);
		expect(seen).toHaveLength(120);
		expect(new Set(seen).size).toBe(120);
		expect(seen[0]).toBe("account-a-0119");
		expect(seen.at(-1)).toBe("account-a-0000");

		const small = await (
			await get("/transactions?limit=2&offset=1", key)
		).json();
		expect(small.data.map((entry: { id: string }) => entry.id)).toEqual([
			"account-a-0118",
			"account-a-0117",
		]);
		expect(small.pagination).toEqual({ limit: 2, offset: 1, hasMore: true });
	});

	it.each([
		["limit=0", "invalid_limit"],
		["limit=101", "invalid_limit"],
		["limit=ten", "invalid_limit"],
		["offset=-1", "invalid_offset"],
		["offset=1.5", "invalid_offset"],
		["appId=app-b", "unknown_parameter"],
		["Limit=5", "unknown_parameter"],
	])("refuses ?%s with %s", async (query, code) => {
		store("account-a", 3);

		const response = await get(`/transactions?${query}`, newKey("app-a"));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code,
			error: expect.any(String),
			message: expect.any(String),
			hint: expect.any(String),
			docs: expect.any(String),
		});
		expect(mocks.queries).toHaveLength(0);
	});

	it("never returns another app's rows", async () => {
		store("account-a", 4);
		store("account-b", 7, "2026-11-05T00:00:00Z");
		const keyA = newKey("app-a");
		const keyB = newKey("app-b");

		const a = await (await get("/transactions?limit=100", keyA)).json();
		const b = await (await get("/transactions?limit=100", keyB)).json();

		expect(a.data).toHaveLength(4);
		expect(b.data).toHaveLength(7);
		expect(
			a.data.every((entry: { id: string }) => entry.id.startsWith("account-a")),
		).toBe(true);
		expect(
			b.data.every((entry: { id: string }) => entry.id.startsWith("account-b")),
		).toBe(true);
		for (const query of mocks.queries) {
			expect(query.sql).toContain("`developer_credit_accounts`.`appId` = ?");
		}
		expect(mocks.queries.map((query) => query.params[0])).toEqual([
			"app-a",
			"app-b",
		]);
	});

	it("returns an empty page for an app with no credit account", async () => {
		mocks.accounts = [];
		store("account-a", 2);

		const body = await (await get("/transactions", newKey("app-a"))).json();

		expect(body).toEqual({
			data: [],
			pagination: { limit: 50, offset: 0, hasMore: false },
		});
	});

	it("shares the rate limiter and its headers with the other endpoints", async () => {
		const key = newKey("app-a");

		const first = await get("/transactions", key);
		const usageAfter = await get("/usage/nope", key);

		expect(first.headers.get("X-RateLimit-Limit")).toBe("60");
		expect(first.headers.get("X-RateLimit-Remaining")).toBe("59");
		expect(usageAfter.headers.get("X-RateLimit-Remaining")).toBe("58");
	});

	it("answers 405 for a method the path does not take", async () => {
		const response = (await rest.POST(
			new Request("https://cap.so/api/developer/v1/transactions", {
				method: "POST",
				headers: { Authorization: `Bearer ${newKey("app-a")}` },
			}),
		)) as Response;

		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});

	it("is described in the OpenAPI document with the fields it returns", async () => {
		store("account-a", 1);
		const spec = developerOpenApiSpec("https://cap.so");
		const operation = spec.paths["/api/developer/v1/transactions"].get;
		const schema = spec.components.schemas.Transaction;

		const body = await (await get("/transactions", newKey("app-a"))).json();

		expect(operation.operationId).toBe("listTransactions");
		expect(operation.parameters.map((parameter) => parameter.name)).toEqual([
			"limit",
			"offset",
		]);
		expect(Object.keys(body.data[0]).sort()).toEqual(
			[...schema.required].sort(),
		);
		expect(Object.keys(schema.properties).sort()).toEqual(
			[...schema.required].sort(),
		);
	});
});

describe("reading a whole ledger for export", () => {
	it("walks every row once, newest first, across batches", async () => {
		store("account-a", 23);
		store("account-b", 5);

		const batches: string[][] = [];
		for await (const batch of readAppLedger("app-a", 10)) {
			batches.push(batch.map((entry) => entry.id));
		}

		expect(batches.map((batch) => batch.length)).toEqual([10, 10, 3]);
		const ids = batches.flat();
		expect(new Set(ids).size).toBe(23);
		expect(ids[0]).toBe("account-a-0022");
		expect(ids.at(-1)).toBe("account-a-0000");
		expect(ids.every((id) => id.startsWith("account-a"))).toBe(true);
	});

	it("does not lose or repeat rows that share a second across a batch edge", async () => {
		const at = new Date("2026-11-12T14:05:09Z");
		for (let index = 0; index < 7; index++) {
			mocks.rows.push({
				id: `same-${index}`,
				accountId: "account-a",
				type: "transcription",
				amountMicroCredits: -33,
				balanceAfterMicroCredits: 1_000 - 33 * (index + 1),
				referenceId: `transcript-${index}`,
				referenceType: "developer_transcript",
				metadata: null,
				createdAt: at,
			});
		}

		const ids: string[] = [];
		for await (const batch of readAppLedger("app-a", 3)) {
			ids.push(...batch.map((entry) => entry.id));
		}

		expect(ids).toHaveLength(7);
		expect(new Set(ids).size).toBe(7);
	});
});
