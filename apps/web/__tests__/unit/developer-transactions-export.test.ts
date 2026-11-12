import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerRow } from "@/lib/infra-ledger";

const mocks = vi.hoisted(() => ({
	user: null as { id: string; email: string } | null,
	apps: [] as { id: string; ownerId: string; deleted?: boolean }[],
	ledgers: {} as Record<string, unknown[][]>,
	read: [] as string[],
	allowed: true,
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const dialect = new MySqlDialect();
	const select = () => {
		let table: unknown = null;
		const query = {
			from(next: unknown) {
				table = next;
				return query;
			},
			where(condition: SQL) {
				const [appId, ownerId] = dialect.sqlToQuery(condition).params;
				const rows =
					table === schema.developerApps
						? mocks.apps.filter(
								(app) =>
									app.id === appId && app.ownerId === ownerId && !app.deleted,
							)
						: [];
				return { limit: async () => rows };
			},
		};
		return query;
	};
	return { db: () => ({ select }) };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));
vi.mock("@/lib/developer-key-hash", () => ({ hashKey: async () => "hash" }));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => mocks.allowed }));
vi.mock("@/lib/infra-ledger-store", () => ({
	readAppLedger: async function* (appId: string) {
		mocks.read.push(appId);
		for (const batch of mocks.ledgers[appId] ?? []) yield batch;
	},
}));

import { GET } from "@/app/api/developer/credits/transactions/route";

const entry = (id: string, amount: number, balance: number): LedgerRow => ({
	id,
	type: amount > 0 ? "topup" : "transcription",
	amountMicroCredits: amount,
	balanceAfterMicroCredits: balance,
	referenceId: amount > 0 ? "pi_3TestPayment" : `transcript-${id}`,
	referenceType: amount > 0 ? "stripe_payment_intent" : "developer_transcript",
	metadata: null,
	createdAt: new Date("2026-11-12T14:05:09Z"),
});

const download = (appId?: string) =>
	GET(
		new Request(
			`https://cap.so/api/developer/credits/transactions${appId === undefined ? "" : `?appId=${appId}`}`,
		),
	) as Promise<Response>;

beforeEach(() => {
	mocks.user = { id: "user-a", email: "a@example.com" };
	mocks.apps = [
		{ id: "app-a", ownerId: "user-a" },
		{ id: "app-b", ownerId: "user-b" },
		{ id: "app-gone", ownerId: "user-a", deleted: true },
	];
	mocks.ledgers = {
		"app-a": [
			[entry("a3", -33, 2_499_934), entry("a2", -33, 2_499_967)],
			[entry("a1", 2_500_000, 2_500_000)],
		],
		"app-b": [[entry("b1", 500_000, 500_000)]],
	};
	mocks.read = [];
	mocks.allowed = true;
});

describe("exporting the ledger as CSV", () => {
	it("needs a signed-in user", async () => {
		mocks.user = null;

		const response = await download("app-a");

		expect(response.status).toBe(401);
		expect(mocks.read).toEqual([]);
	});

	it("is not open to accounts outside the preview", async () => {
		mocks.allowed = false;

		const response = await download("app-a");

		expect(response.status).toBe(403);
		expect(mocks.read).toEqual([]);
	});

	it.each([
		["another account's app", "app-b"],
		["a deleted app", "app-gone"],
		["an app that does not exist", "app-nope"],
	])("answers 404 for %s and reads nothing", async (_name, appId) => {
		const response = await download(appId);

		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("b1");
		expect(mocks.read).toEqual([]);
	});

	it("refuses a request that names no app", async () => {
		const response = await download();

		expect(response.status).toBe(400);
		expect(mocks.read).toEqual([]);
	});

	it("downloads every row of the owner's app as a file", async () => {
		const response = await download("app-a");

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/csv; charset=utf-8",
		);
		expect(response.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename="cap-infra-transactions-\d{4}-\d{2}-\d{2}\.csv"$/,
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		const lines = (await response.text()).trimEnd().split("\r\n");
		expect(lines).toEqual([
			"id,time_utc,type,note,reference_type,reference_id,amount_usd,amount_micro_credits,balance_usd,balance_micro_credits",
			"a3,2026-11-12T14:05:09Z,Transcription,,developer_transcript,transcript-a3,-0.00033,-33,24.99934,2499934",
			"a2,2026-11-12T14:05:09Z,Transcription,,developer_transcript,transcript-a2,-0.00033,-33,24.99967,2499967",
			"a1,2026-11-12T14:05:09Z,Top-up,,stripe_payment_intent,pi_3TestPayment,25.00,2500000,25.00,2500000",
		]);
		expect(mocks.read).toEqual(["app-a"]);
	});

	it("is a header alone for an app with no transactions", async () => {
		mocks.ledgers["app-a"] = [];

		const response = await download("app-a");

		expect(response.status).toBe(200);
		expect((await response.text()).trimEnd().split("\r\n")).toHaveLength(1);
	});
});
