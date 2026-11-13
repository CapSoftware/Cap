import { createHash } from "node:crypto";
import type { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrgAnalyticsData } from "@/app/(org)/dashboard/analytics/data";
import type { AnalyticsRange } from "@/app/(org)/dashboard/analytics/types";

type TinybirdStub = {
	querySql: (statement: string) => Effect.Effect<{ data: unknown[] }, Error>;
};
const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	tinybirdQuery: vi.fn(),
	latency: 0,
	size: 200,
	emptySpace: false,
	fallback: false,
	failTinybird: false,
	failDatabase: false,
	pending: null as Array<() => void> | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	return { Tinybird: Context.GenericTag<TinybirdStub>("Tinybird") };
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Tinybird } = (await import("@cap/web-backend")) as unknown as {
		Tinybird: import("effect").Context.Tag<TinybirdStub, TinybirdStub>;
	};
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, TinybirdStub>) =>
			Effect.runPromise(
				Effect.provideService(effect, Tinybird, {
					querySql: (statement) =>
						Effect.tryPromise(() => mocks.tinybirdQuery(statement)),
				}),
			),
	};
});

const now = new Date("2026-01-08T12:00:00Z");
const bucket = "2026-01-07T00:00:00Z";
const hourlyBucket = "2026-01-07T13:00:00Z";
const topCaps = Array.from({ length: 10 }, (_, index) => ({
	pathname: `/s/cap-${index}`,
	views: 200 - index * 10,
}));
async function waitForQuery() {
	if (mocks.pending) {
		await new Promise<void>((resolve) => mocks.pending?.push(resolve));
	} else if (mocks.latency) {
		await new Promise((resolve) => setTimeout(resolve, mocks.latency));
	}
}
function installQueries() {
	mocks.query.mockImplementation(
		async (statement: string, params: unknown[]) => {
			await waitForQuery();
			if (mocks.failDatabase) throw new Error("Database unavailable");
			if (statement.startsWith("select `videoId` from `space_videos`")) {
				return {
					rows: mocks.emptySpace
						? []
						: Array.from({ length: 20 }, (_, index) => [`cap-${index}`]),
				};
			}
			if (statement.includes("MIN(")) {
				return { rows: [[new Date("2026-01-01T12:00:00Z")]] };
			}
			if (statement.startsWith("select `id`, `name`")) {
				return {
					rows: params
						.filter(
							(id): id is string =>
								typeof id === "string" && id.startsWith("cap-"),
						)
						.map((id) => [id, `Recording ${id}`]),
				};
			}
			if (statement.includes("COUNT(*)")) {
				return {
					rows: [
						[
							statement.includes("%H") ? hourlyBucket : bucket,
							params.includes("text")
								? mocks.size * 4
								: params.includes("emoji")
									? mocks.size * 6
									: mocks.size,
						],
					],
				};
			}
			throw new Error(`Unexpected SQL: ${statement}`);
		},
	);
	mocks.tinybirdQuery.mockImplementation(async (statement: string) => {
		await waitForQuery();
		if (mocks.failTinybird) throw new Error("Tinybird unavailable");
		if (mocks.fallback && !statement.includes("FROM analytics_events")) {
			return { data: [] };
		}
		if (statement.includes("GROUP BY bucket")) {
			return {
				data: [
					{
						bucket: statement.includes("toStartOfHour") ? hourlyBucket : bucket,
						views: mocks.size * 20,
					},
				],
			};
		}
		if (statement.includes("GROUP BY pathname"))
			return {
				data: topCaps.map((row) => ({
					...row,
					views: (row.views * mocks.size) / 200,
				})),
			};
		if (statement.includes("GROUP BY country, city")) {
			return {
				data: [{ city: "London", country: "GB", views: mocks.size * 6 }],
			};
		}
		const name = statement.includes("GROUP BY name")
			? statement.includes("browser")
				? "chrome"
				: statement.includes("device")
					? "pc"
					: statement.includes("os as") || statement.includes("nullIf(os,")
						? "mac os"
						: "GB"
			: "";
		return { data: [{ name, views: mocks.size * 6 }] };
	});
}
function expected(
	capId?: string,
	range: AnalyticsRange = "7d",
	capCount = capId ? 1 : 200,
) {
	const start =
		range === "24h"
			? "2026-01-07T12:00:00Z"
			: range === "30d"
				? "2025-12-09T00:00:00Z"
				: "2026-01-01T00:00:00Z";
	const size = range === "24h" ? 25 : range === "30d" ? 31 : 8;
	const step = range === "24h" ? 3600000 : 86400000;
	return {
		counts: {
			caps: capCount,
			views: capCount * 20,
			comments: capCount * 4,
			reactions: capCount * 6,
		},
		chart: Array.from({ length: size }, (_, index) => {
			const timestamp = new Date(new Date(start).getTime() + index * step)
				.toISOString()
				.replace(".000Z", "Z");
			const populated = timestamp === (range === "24h" ? hourlyBucket : bucket);
			return {
				bucket: timestamp,
				caps: populated ? capCount : 0,
				views: populated ? capCount * 20 : 0,
				comments: populated ? capCount * 4 : 0,
				reactions: populated ? capCount * 6 : 0,
			};
		}),
		breakdowns: {
			countries: [{ name: "GB", views: capCount * 6, percentage: 0.3 }],
			cities: [{ name: "London", views: capCount * 6, percentage: 0.3 }],
			browsers: [{ name: "Chrome", views: capCount * 6, percentage: 0.3 }],
			operatingSystems: [
				{ name: "macOS", views: capCount * 6, percentage: 0.3 },
			],
			devices: [{ name: "Desktop", views: capCount * 6, percentage: 0.3 }],
			topCaps: capId
				? []
				: topCaps.map((row, index) => ({
						id: `cap-${index}`,
						name: `Recording cap-${index}`,
						views: (row.views * capCount) / 200,
						percentage: row.views / 4000,
					})),
		},
		capName: capId ? `Recording ${capId}` : undefined,
	};
}
async function measureRounds(spaceId?: string) {
	mocks.pending = [];
	let settled = false;
	const result = getOrgAnalyticsData("org-1", "7d", spaceId).finally(() => {
		settled = true;
	});
	let rounds = 0;
	let idleTicks = 0;
	while (!settled) {
		const issued =
			mocks.query.mock.calls.length + mocks.tinybirdQuery.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (
			issued !==
				mocks.query.mock.calls.length + mocks.tinybirdQuery.mock.calls.length ||
			!mocks.pending.length
		) {
			idleTicks = 0;
			continue;
		}
		if (++idleTicks < 3) continue;
		idleTicks = 0;
		rounds++;
		for (const release of mocks.pending.splice(0)) release();
	}
	mocks.pending = null;
	return { data: await result, rounds };
}
beforeEach(() => {
	vi.setSystemTime(now);
	mocks.latency = 0;
	mocks.size = 200;
	mocks.emptySpace = false;
	mocks.fallback = false;
	mocks.failTinybird = false;
	mocks.failDatabase = false;
	mocks.pending = null;
	installQueries();
});
afterEach(() => vi.useRealTimers());
describe("dashboard analytics loader", () => {
	it.each(["24h", "30d"] as const)(
		"preserves %s range buckets",
		async (range) => {
			expect(await getOrgAnalyticsData("org-1", range)).toEqual(
				expected(undefined, range),
			);
		},
	);
	it.each([undefined, "space-1"])(
		"preserves the full response for space %s",
		async (spaceId) => {
			mocks.size = spaceId ? 20 : 200;
			expect(await getOrgAnalyticsData("org-1", "7d", spaceId)).toEqual(
				expected(undefined, "7d", mocks.size),
			);
			expect(mocks.query).toHaveBeenCalledTimes(spaceId ? 5 : 4);
			expect(mocks.tinybirdQuery).toHaveBeenCalledTimes(7);
			if (spaceId) {
				for (const [statement] of mocks.tinybirdQuery.mock.calls) {
					expect(statement).toContain("AND pathname IN ('/s/cap-0'");
				}
				for (const [statement, params] of mocks.query.mock.calls) {
					if (statement.includes("COUNT(*)")) {
						expect(params).toContain("org-1");
						expect(params).toContain("cap-19");
					}
				}
			}
		},
	);
	it("keeps the cap filter, name and suppression of top caps", async () => {
		mocks.size = 1;
		expect(
			await getOrgAnalyticsData("org-1", "7d", undefined, "cap-3"),
		).toEqual(expected("cap-3"));
		expect(mocks.query).toHaveBeenCalledTimes(4);
		expect(mocks.tinybirdQuery).toHaveBeenCalledTimes(6);
		for (const [statement] of mocks.tinybirdQuery.mock.calls) {
			expect(statement).toContain("AND pathname IN ('/s/cap-3')");
		}
	});
	it("does not query analytics for an empty space", async () => {
		mocks.emptySpace = true;
		const data = await getOrgAnalyticsData("org-1", "7d", "empty");
		expect(data.counts).toEqual({
			caps: 0,
			views: 0,
			comments: 0,
			reactions: 0,
		});
		expect(data.chart).toHaveLength(8);
		expect(
			Object.values(data.breakdowns).every((rows) => rows.length === 0),
		).toBe(true);
		expect(mocks.query).toHaveBeenCalledTimes(1);
		expect(mocks.tinybirdQuery).not.toHaveBeenCalled();
	});
	it("preserves aggregate-to-raw fallback output", async () => {
		mocks.fallback = true;
		expect(await getOrgAnalyticsData("org-1", "7d")).toEqual(expected());
		expect(mocks.tinybirdQuery).toHaveBeenCalledTimes(14);
	});
	it("keeps SQL counts when Tinybird fails", async () => {
		mocks.failTinybird = true;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const data = await getOrgAnalyticsData("org-1", "7d");
		expect(data.counts).toEqual({
			caps: 200,
			views: 0,
			comments: 800,
			reactions: 1200,
		});
		expect(
			Object.values(data.breakdowns).every((rows) => rows.length === 0),
		).toBe(true);
		expect(mocks.tinybirdQuery).toHaveBeenCalledTimes(14);
	});
	it("still rejects database failures", async () => {
		mocks.failDatabase = true;
		await expect(getOrgAnalyticsData("org-1", "7d")).rejects.toThrow();
	});
	it("resolves lifetime bounds before querying analytics", async () => {
		expect(await getOrgAnalyticsData("org-1", "lifetime")).toEqual(expected());
		expect(mocks.query.mock.calls[0]?.[0]).toContain("MIN(");
		expect(mocks.query).toHaveBeenCalledTimes(5);
	});
	it("overlaps independent SQL and Tinybird reads in two rounds", async () => {
		const { data, rounds } = await measureRounds();
		expect(data).toEqual(expected());
		expect(rounds).toBe(2);
	});
	it.skipIf(!process.env.CAP_BENCH_DASHBOARD_ANALYTICS)(
		"measures a 200-Cap org at 20 and 40 ms query latency",
		async () => {
			for (const fallback of [false, true]) {
				mocks.fallback = fallback;
				for (const latency of [20, 40]) {
					mocks.latency = latency;
					for (const spaceId of [undefined, "space-1"]) {
						mocks.size = spaceId ? 20 : 200;
						mocks.query.mockClear();
						mocks.tinybirdQuery.mockClear();
						const { data, rounds } = await measureRounds(spaceId);
						expect(data).toEqual(expected(undefined, "7d", mocks.size));
						const queries =
							mocks.query.mock.calls.length +
							mocks.tinybirdQuery.mock.calls.length;
						const times: number[] = [];
						for (let iteration = 0; iteration < 7; iteration++) {
							const start = performance.now();
							expect(await getOrgAnalyticsData("org-1", "7d", spaceId)).toEqual(
								expected(undefined, "7d", mocks.size),
							);
							times.push(performance.now() - start);
						}
						times.sort((a, b) => a - b);
						console.log(
							JSON.stringify({
								spaceId,
								fallback,
								latency,
								queries,
								rounds,
								medianMs: times[3],
								outputHash: createHash("sha256")
									.update(JSON.stringify(data))
									.digest("hex"),
							}),
						);
					}
				}
			}
		},
		60_000,
	);
});
