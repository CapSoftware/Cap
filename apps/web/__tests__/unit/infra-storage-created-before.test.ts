import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { getAppStorage, getStorageUsageByApp } from "@/lib/infra-storage";

beforeEach(() => {
	state.queries = [];
});

describe("stored video bounded by creation time", () => {
	it("adds the bound to the same aggregate query", async () => {
		const dayEnd = new Date("2026-11-13T00:00:00.000Z");

		await getStorageUsageByApp(["app-1", "app-2"], undefined, undefined, {
			createdBefore: dayEnd,
		});

		expect(state.queries).toHaveLength(1);
		const [{ sql, params }] = state.queries as [
			{ sql: string; params: unknown[] },
		];
		expect(sql).toContain("COALESCE(SUM(`duration`), 0)");
		expect(sql).toContain("and `developer_videos`.`createdAt` < ?)");
		expect(sql).toContain("group by");
		expect(params.slice(-3)).toEqual([
			"app-1",
			"app-2",
			"2026-11-13 00:00:00.000",
		]);
	});

	it("reads every stored video when no bound is given", async () => {
		await getStorageUsageByApp(["app-1"]);
		await getAppStorage("app-1");

		expect(state.queries).toHaveLength(2);
		for (const { sql } of state.queries) {
			expect(sql).not.toContain("createdAt");
		}
	});
});
