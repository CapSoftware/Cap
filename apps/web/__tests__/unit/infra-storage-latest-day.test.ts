import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	queries: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(async (sql, params) => {
		state.queries.push({ sql, params });
		return { rows: [] };
	});
	return { db: () => client };
});

import { db } from "@cap/database";
import {
	latestStorageCharge,
	latestStorageCharges,
} from "@/lib/infra-standing";

const LATEST_DAY =
	"(select `developer_credit_transactions`.`accountId`, `developer_credit_transactions`.`referenceId` from `developer_credit_transactions` where `developer_credit_transactions`.`accountId` = ? and `developer_credit_transactions`.`referenceType` = ? and `developer_credit_transactions`.`referenceId` <= ? order by `developer_credit_transactions`.`referenceId` desc limit 1)";

beforeEach(() => {
	state.queries = [];
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-13T23:59:59Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("latest storage day", () => {
	it("orders one account's storage day rows by the day they bill, up to tomorrow", async () => {
		await latestStorageCharge(db() as never, "account-1");

		expect(state.queries).toHaveLength(2);
		const [{ sql, params }, firstMonth] = state.queries as [
			{ sql: string; params: unknown[] },
			{ sql: string; params: unknown[] },
		];
		expect(firstMonth.params).toEqual(["account-1", "video_create", 1]);
		expect(firstMonth.sql).not.toContain("referenceId");
		expect(sql).toBe(
			"select `id`, `createdAt`, `metadata` from `developer_credit_transactions` where (`developer_credit_transactions`.`accountId` = ? and (`developer_credit_transactions`.`type` = ? and `developer_credit_transactions`.`referenceType` = ?) and `developer_credit_transactions`.`referenceId` <= ?) order by `developer_credit_transactions`.`referenceId` desc, `developer_credit_transactions`.`id` desc limit ?",
		);
		expect(params).toEqual([
			"account-1",
			"storage_daily",
			"storage_day",
			"2026-11-14",
			1,
		]);
	});

	it("finds every account's latest day in one statement, one bounded lookup per account", async () => {
		await latestStorageCharges(db() as never, ["account-1", "account-2"]);

		expect(state.queries).toHaveLength(1);
		const [{ sql, params }] = state.queries as [
			{ sql: string; params: unknown[] },
		];
		expect(sql).toContain(
			`in (select latest.accountId, latest.referenceId from (${LATEST_DAY} union all ${LATEST_DAY}) latest)`,
		);
		expect(params).toEqual([
			"storage_daily",
			"storage_day",
			"account-1",
			"storage_day",
			"2026-11-14",
			"account-2",
			"storage_day",
			"2026-11-14",
		]);
	});

	it("reads nothing for no accounts", async () => {
		expect(await latestStorageCharges(db() as never, [])).toEqual(new Map());
		expect(state.queries).toEqual([]);
	});
});
