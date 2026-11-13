import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	due: [] as string[],
	pages: [] as { sql: string; cursor: string | null; limit: number }[],
	accountReads: 0,
	other: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(async (sql, params) => {
		if (sql.startsWith("select `developer_credit_accounts`.`id` from")) {
			const limit = Number(params.at(-1));
			const cursor = sql.includes("`id` > ?") ? String(params.at(-2)) : null;
			state.pages.push({ sql, cursor, limit });
			return {
				rows: state.due
					.filter((id) => cursor === null || id > cursor)
					.slice(0, limit)
					.map((id) => [id]),
			};
		}
		state.accountReads += 1;
		state.other.push({ sql, params });
		return { rows: [] };
	});
	return { db: () => client };
});
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "row",
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/utils", () => ({ stripe: () => ({}) }));
vi.mock("@/lib/infra-billing-emails", () => ({
	sendInfraTopUpFailedEmail: vi.fn(),
}));

import { getAutoTopUpFailure, runDueAutoTopUps } from "@/lib/infra-auto-top-up";

beforeEach(() => {
	state.due = Array.from(
		{ length: 450 },
		(_, index) => `account-${String(index).padStart(4, "0")}`,
	);
	state.pages = [];
	state.accountReads = 0;
	state.other = [];
});

describe("auto top-up sweep selection", () => {
	it("pages through due accounts by id", async () => {
		await runDueAutoTopUps(new Date("2026-11-12T06:41:00Z"));

		expect(state.pages.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual(
			[
				{ cursor: null, limit: 200 },
				{ cursor: "account-0199", limit: 200 },
				{ cursor: "account-0399", limit: 200 },
			],
		);
		expect(state.accountReads).toBe(450);
	});

	it("asks the database for enabled accounts under their threshold after held credit", async () => {
		state.due = [];

		await runDueAutoTopUps(new Date("2026-11-12T06:41:00Z"));

		expect(state.pages).toHaveLength(1);
		const sql = state.pages[0]?.sql ?? "";
		expect(sql).toContain("`autoTopUpEnabled` = ?");
		expect(sql).toContain("`stripePaymentMethodId` is not null");
		expect(sql).toContain(
			"`balanceMicroCredits` < `developer_credit_accounts`.`autoTopUpThresholdMicroCredits` + ((select COALESCE(SUM(`reservedMicroCredits`), 0)",
		);
		expect(sql).toContain(
			"`developer_transcripts`.`appId` = `developer_credit_accounts`.`appId`",
		);
		expect(sql).toContain("order by `developer_credit_accounts`.`id` asc");
	});

	it("stops between accounts when its time is up", async () => {
		const start = Date.now();
		let reads = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => {
			reads += 1;
			return start + reads * 1000;
		});

		await runDueAutoTopUps(new Date(start), { until: start + 10_500 });

		clock.mockRestore();
		expect(state.accountReads).toBe(10);
		expect(state.pages).toHaveLength(1);
	});
});

describe("last auto top-up lookup", () => {
	it("reads the account's top-up rows by type, so the account and type index serves it", async () => {
		expect(await getAutoTopUpFailure("account-0001")).toBeNull();

		expect(state.other).toHaveLength(1);
		const [{ sql, params }] = state.other as [
			{ sql: string; params: unknown[] },
		];
		expect(sql).toContain(
			"where (`developer_credit_transactions`.`accountId` = ? and `developer_credit_transactions`.`type` in (?, ?) and `developer_credit_transactions`.`referenceType` in (?, ?))",
		);
		expect(sql).toContain(
			"order by `developer_credit_transactions`.`createdAt` desc limit ?",
		);
		expect(params).toEqual([
			"account-0001",
			"topup",
			"topup_failed",
			"auto_top_up",
			"auto_top_up_failed",
			1,
		]);
	});
});
