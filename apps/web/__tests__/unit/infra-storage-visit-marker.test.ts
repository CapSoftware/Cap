import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	queries: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(async (sql, params) => {
		state.queries.push({ sql, params });
		return { rows: [{ affectedRows: 0, insertId: 0 }] };
	});
	return { db: () => client };
});
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "marker-id",
	nanoIdLength: 15,
}));

import { recordStorageDayVisits } from "@/lib/infra-storage-billing";

beforeEach(() => {
	state.queries = [];
});

describe("storage day visit markers", () => {
	it("writes every visited app of a page in one statement and changes nothing that exists", async () => {
		await recordStorageDayVisits({
			appIds: ["app-1", "app-2"],
			dateKey: "2026-11-12",
			now: new Date("2026-11-12T06:41:00Z"),
		});

		expect(state.queries).toHaveLength(1);
		const [{ sql, params }] = state.queries as [
			{ sql: string; params: unknown[] },
		];
		expect(sql).toMatch(
			/^insert into `developer_daily_storage_snapshots` .* values \(.*\), \(.*\) on duplicate key update `appId` = `developer_daily_storage_snapshots`\.`appId`$/,
		);
		expect(params).toEqual([
			"marker-id",
			"app-1",
			"2026-11-12",
			0,
			0,
			0,
			"2026-11-12 06:41:00.000",
			"marker-id",
			"app-2",
			"2026-11-12",
			0,
			0,
			0,
			"2026-11-12 06:41:00.000",
		]);
	});

	it("does nothing for a page with no idle visits", async () => {
		await recordStorageDayVisits({
			appIds: [],
			dateKey: "2026-11-12",
			now: new Date("2026-11-12T06:41:00Z"),
		});

		expect(state.queries).toEqual([]);
	});
});
