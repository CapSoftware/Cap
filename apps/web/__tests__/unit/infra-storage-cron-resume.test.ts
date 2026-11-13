import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	accounts: [] as { id: string; appId: string }[],
	deletedApps: new Set<string>(),
	charged: new Map<string, number>(),
	chargeCalls: [] as string[],
	accountReads: [] as { cursor: string | null; limit: number | null }[],
	accountSql: [] as string[],
	longestIdList: 0,
	secondsPerCharge: 0,
	topUps: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(async (sql, params) => {
		if (sql.includes("from `developer_credit_accounts`")) {
			const limit = /limit \?/.test(sql) ? Number(params.at(-1)) : null;
			const cursor = /`id` > \?/.test(sql) ? String(params[0]) : null;
			state.accountReads.push({ cursor, limit });
			state.accountSql.push(sql);
			const after = state.accounts.filter(
				(account) => cursor === null || account.id > cursor,
			);
			return {
				rows: (limit === null ? after : after.slice(0, limit)).map(
					(account) => [account.id, account.appId],
				),
			};
		}
		if (sql.includes("from `developer_apps`")) {
			return {
				rows: params
					.map(String)
					.filter((appId) => !state.deletedApps.has(appId))
					.map((appId) => [appId]),
			};
		}
		if (sql.includes("from `developer_credit_transactions`")) {
			const ids = params.slice(0, -2).map(String);
			state.longestIdList = Math.max(state.longestIdList, ids.length);
			return {
				rows: ids.filter((id) => state.charged.has(id)).map((id) => [id]),
			};
		}
		throw new Error(`Unexpected query: ${sql}`);
	});
	return { db: () => client };
});
vi.mock("@/lib/infra-storage", () => ({
	getStorageUsageByApp: async (appIds: string[]) =>
		new Map(
			appIds.map((appId) => [
				appId,
				{
					videoCount: 1,
					totalMinutes: 10,
					minutesByTier: { "1080p": 10, "1440p": 0, "2160p": 0 },
					monthlyMicroCredits: 840,
					dailyMicroCredits: 28,
				},
			]),
		),
}));
vi.mock("@/lib/infra-storage-billing", () => ({
	chargeStorageDay: async ({ accountId }: { accountId: string }) => {
		state.chargeCalls.push(accountId);
		vi.setSystemTime(Date.now() + state.secondsPerCharge * 1000);
		if (state.charged.has(accountId)) return { state: "skipped" };
		state.charged.set(accountId, (state.charged.get(accountId) ?? 0) + 1);
		return {
			state: "billed",
			owedMicroCredits: 28,
			chargedMicroCredits: 28,
			balanceMicroCredits: 972,
			shortSince: null,
			fellShort: false,
		};
	},
}));
vi.mock("@/lib/infra-standing", () => ({
	INFRA_GRACE_DAYS: 7,
	STORAGE_DAY_REFERENCE_TYPE: "storage_day",
	latestStorageCharge: async () => null,
	latestStorageCharges: async () => new Map(),
}));
vi.mock("@/lib/infra-auto-top-up", () => ({ runDueAutoTopUps: state.topUps }));
vi.mock("@/lib/infra-billing-emails", () => ({
	sendInfraOutOfCreditEmail: vi.fn(),
}));

import { GET, maxDuration } from "@/app/api/cron/developer-storage/route";

const ACCOUNTS = 450;

const run = async () => {
	const response = await GET(
		new Request("https://localhost/api/cron/developer-storage", {
			headers: { authorization: "Bearer cron-secret" },
		}),
	);
	return response.json();
};

beforeEach(() => {
	process.env.CRON_SECRET = "cron-secret";
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-12T06:41:00Z"));
	state.accounts = Array.from({ length: ACCOUNTS }, (_, index) => {
		const serial = String(index).padStart(4, "0");
		return { id: `account-${serial}`, appId: `app-${serial}` };
	});
	state.deletedApps = new Set();
	state.charged = new Map();
	state.chargeCalls = [];
	state.accountReads = [];
	state.accountSql = [];
	state.longestIdList = 0;
	state.secondsPerCharge = 0;
	state.topUps.mockReset();
	state.topUps.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("storage cron paging and time budget", () => {
	it("reads accounts a page at a time, by id, and never sends every id at once", async () => {
		const body = await run();

		expect(body).toMatchObject({ complete: true, appsProcessed: ACCOUNTS });
		expect(state.accountReads).toEqual([
			{ cursor: null, limit: 200 },
			{ cursor: "account-0199", limit: 200 },
			{ cursor: "account-0399", limit: 200 },
		]);
		expect(state.longestIdList).toBe(200);
	});

	it("pages on the account id alone and leaves out accounts of deleted apps", async () => {
		state.deletedApps = new Set(["app-0003", "app-0250"]);

		const body = await run();

		expect(body).toMatchObject({ complete: true, appsProcessed: ACCOUNTS - 2 });
		expect(state.charged.has("account-0003")).toBe(false);
		expect(state.charged.has("account-0250")).toBe(false);
		expect(state.accountSql.every((sql) => !sql.includes("join"))).toBe(true);
		expect(state.accountReads).toHaveLength(3);
	});

	it("stops before the function limit and says the run is not complete", async () => {
		state.secondsPerCharge = 1.6;
		const startedAt = Date.now();

		const body = await run();

		expect(body).toMatchObject({ complete: false, appsProcessed: 130 });
		expect(state.charged.size).toBe(130);
		expect(Date.now() - startedAt).toBeLessThan(maxDuration * 1000);
		expect(maxDuration).toBe(300);
	});

	it("carries on from a cut-off run without charging twice or skipping an account", async () => {
		state.secondsPerCharge = 1.6;
		const first = await run();
		expect(first).toMatchObject({ complete: false, appsProcessed: 130 });
		const chargedInFirstRun = new Set(state.charged.keys());
		state.chargeCalls = [];
		state.secondsPerCharge = 0;

		const second = await run();

		expect(second).toMatchObject({
			complete: true,
			appsProcessed: ACCOUNTS - 130,
		});
		expect(state.chargeCalls.some((id) => chargedInFirstRun.has(id))).toBe(
			false,
		);
		expect([...state.charged.keys()].sort()).toEqual(
			state.accounts.map((account) => account.id),
		);
		expect([...state.charged.values()].every((count) => count === 1)).toBe(
			true,
		);

		state.chargeCalls = [];
		const third = await run();

		expect(third).toMatchObject({ complete: true, appsProcessed: 0 });
		expect(state.chargeCalls).toEqual([]);
	});

	it("gives each auto top-up pass a deadline inside the function limit", async () => {
		const startedAt = Date.now();

		await run();

		const deadlines = state.topUps.mock.calls.map(
			([, options]) => (options as { until: number }).until - startedAt,
		);
		expect(deadlines).toHaveLength(2);
		for (const deadline of deadlines) {
			expect(deadline).toBeGreaterThan(0);
			expect(deadline).toBeLessThan(maxDuration * 1000);
		}
	});
});
