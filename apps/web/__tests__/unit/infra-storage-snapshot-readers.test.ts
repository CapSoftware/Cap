import { User } from "@cap/web-domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Snapshot = {
	snapshotDate: string;
	totalDurationMinutes: number;
	videoCount: number;
	microCreditsCharged: number;
};

const state = vi.hoisted(() => ({
	queries: [] as string[],
	snapshots: [] as {
		snapshotDate: string;
		totalDurationMinutes: number;
		videoCount: number;
		microCreditsCharged: number;
	}[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const STAMP = "2026-11-01 00:00:00";
	const client = drizzle(async (sql, params) => {
		state.queries.push(sql);
		if (sql.includes("from `developer_daily_storage_snapshots`")) {
			const skipsZero = sql.includes(
				"`developer_daily_storage_snapshots`.`totalDurationMinutes` > ?",
			);
			const since = params.find(
				(value) =>
					typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
			);
			const rows = state.snapshots
				.filter((row) => !skipsZero || row.totalDurationMinutes > 0)
				.filter((row) => !since || row.snapshotDate >= String(since))
				.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
			if (
				sql.startsWith(
					"select `developer_daily_storage_snapshots`.`totalDurationMinutes`",
				) ||
				sql.startsWith("select `totalDurationMinutes` from")
			) {
				return {
					rows: rows.slice(0, 1).map((row) => [row.totalDurationMinutes]),
				};
			}
			return {
				rows: rows.map((row) => [
					row.snapshotDate,
					row.totalDurationMinutes,
					row.videoCount,
					row.microCreditsCharged,
				]),
			};
		}
		if (sql.includes("from `developer_apps`")) {
			return {
				rows: [["app-1", "First app", "production", null, STAMP, STAMP]],
			};
		}
		if (sql.includes("from `developer_credit_accounts`")) {
			return { rows: [[5_000_000, 0, 0, 0, 0]] };
		}
		if (sql.includes("COUNT(*)")) return { rows: [[3]] };
		return { rows: [] };
	});
	return { db: () => client };
});

import { getInfraStorageSnapshots } from "@/app/(infra)/dashboard/infra/infra-data";
import { summarizeStorageMonth } from "@/lib/infra-usage";
import { AgentManagement } from "../../../../packages/web-backend/src/AgentManagement";

const charged = (snapshotDate: string, minutes: number): Snapshot => ({
	snapshotDate,
	totalDurationMinutes: minutes,
	videoCount: 2,
	microCreditsCharged: 120,
});
const unpaid = (snapshotDate: string): Snapshot => ({
	snapshotDate,
	totalDurationMinutes: 30,
	videoCount: 2,
	microCreditsCharged: 0,
});
const marker = (snapshotDate: string): Snapshot => ({
	snapshotDate,
	totalDurationMinutes: 0,
	videoCount: 0,
	microCreditsCharged: 0,
});

const appContext = () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const agents = yield* AgentManagement;
			return yield* agents.getDeveloperAppContext(
				User.UserId.make("user-1"),
				"app-1",
			);
		}).pipe(Effect.provide(AgentManagement.Default)),
	);

beforeEach(() => {
	state.queries = [];
	state.snapshots = [
		charged("2026-11-09", 40),
		unpaid("2026-11-10"),
		charged("2026-11-11", 45),
	];
});

describe("readers of daily storage snapshots ignore visit markers", () => {
	it("the console usage history and month summary are the same with markers on other days", async () => {
		const now = new Date("2026-11-13T12:00:00Z");
		const before = await getInfraStorageSnapshots("app-1", "2026-10-01");
		state.snapshots.push(marker("2026-11-12"), marker("2026-11-13"));

		const after = await getInfraStorageSnapshots("app-1", "2026-10-01");

		expect(after).toEqual(before);
		expect(after.map((row) => row.snapshotDate)).toEqual([
			"2026-11-11",
			"2026-11-10",
			"2026-11-09",
		]);
		expect(summarizeStorageMonth(after, now)).toEqual(
			summarizeStorageMonth(before, now),
		);
		expect(summarizeStorageMonth(after, now)).toEqual({
			chargedMicroCredits: 240,
			billedDays: 3,
		});
	});

	it("the agent API reports the last stored minutes, not a later marker", async () => {
		const before = await appContext();
		state.snapshots.push(marker("2026-11-12"));

		const after = await appContext();

		expect(before.storageMinutes).toBe(45);
		expect(after.storageMinutes).toBe(45);
		expect(after).toEqual(before);
	});
});
