import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as { tier: string; seconds: unknown }[],
	failure: null as unknown,
	where: [] as unknown[],
	groupBy: 0,
}));

vi.mock("@cap/database", () => ({
	db: () => {
		const chain = {
			select: () => chain,
			from: () => chain,
			where: (condition: unknown) => {
				mocks.where.push(condition);
				return chain;
			},
			groupBy: () => {
				mocks.groupBy++;
				return mocks.failure
					? Promise.reject(mocks.failure)
					: Promise.resolve(mocks.rows);
			},
		};
		return chain;
	},
}));

import {
	deliveryJson,
	deliveryPeriod,
	getDeliveredUsage,
	isMissingTableError,
	sumDeliveryRows,
} from "@/lib/infra-delivery";

const dialect = new MySqlDialect();
const query = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

beforeEach(() => {
	mocks.rows = [];
	mocks.failure = null;
	mocks.where = [];
	mocks.groupBy = 0;
});

describe("getDeliveredUsage", () => {
	it("returns null when the delivery table does not exist yet", async () => {
		mocks.failure = Object.assign(new Error("Failed query"), {
			cause: Object.assign(new Error("Table doesn't exist"), {
				code: "ER_NO_SUCH_TABLE",
				errno: 1146,
			}),
		});

		await expect(getDeliveredUsage("app-1")).resolves.toBeNull();
	});

	it("throws any other database error", async () => {
		mocks.failure = Object.assign(new Error("Failed query"), {
			cause: Object.assign(new Error("Lock wait timeout"), {
				code: "ER_LOCK_WAIT_TIMEOUT",
				errno: 1205,
			}),
		});

		await expect(getDeliveredUsage("app-1")).rejects.toThrow("Failed query");
	});

	it("returns null when nothing was measured this month", async () => {
		await expect(getDeliveredUsage("app-1")).resolves.toBeNull();
	});

	it("sums seconds for each tier", async () => {
		mocks.rows = [
			{ tier: "720p", seconds: "20160" },
			{ tier: "1080p", seconds: "54000" },
			{ tier: "360p", seconds: 750 },
		];

		await expect(getDeliveredUsage("app-1")).resolves.toEqual({
			seconds: 74_910,
			secondsByTier: {
				"360p": 750,
				"720p": 20_160,
				"1080p": 54_000,
				"1440p": 0,
				"2160p": 0,
			},
		});
	});

	it("reads one app over the UTC calendar month, on the primary key prefix", async () => {
		await getDeliveredUsage("app-1", new Date("2026-11-30T23:59:59.999Z"));

		const { sql, params } = query(mocks.where[0]);
		expect(sql).toBe(
			"(`developer_delivery_daily`.`appId` = ? and `developer_delivery_daily`.`day` >= ? and `developer_delivery_daily`.`day` < ?)",
		);
		expect(params).toEqual(["app-1", "2026-11-01", "2026-12-01"]);
		expect(mocks.groupBy).toBe(1);
	});
});

describe("deliveryPeriod", () => {
	it("starts at 00:00 UTC on the 1st, the same as speech", () => {
		expect(deliveryPeriod(new Date("2026-11-01T00:00:00Z"))).toEqual({
			start: new Date("2026-11-01T00:00:00Z"),
			startDay: "2026-11-01",
			endDay: "2026-12-01",
		});
	});

	it("rolls over the year in December", () => {
		expect(deliveryPeriod(new Date("2026-12-31T23:59:59Z"))).toMatchObject({
			startDay: "2026-12-01",
			endDay: "2027-01-01",
		});
	});
});

describe("delivery rows", () => {
	it("ignores tiers it does not know and empty values", () => {
		expect(
			sumDeliveryRows([
				{ tier: "480p", seconds: 600 },
				{ tier: "1080p", seconds: null },
			]),
		).toEqual({
			seconds: 0,
			secondsByTier: {
				"360p": 0,
				"720p": 0,
				"1080p": 0,
				"1440p": 0,
				"2160p": 0,
			},
		});
		expect(sumDeliveryRows([{ tier: "480p", seconds: 600 }])).toBeNull();
	});

	it("reports minutes, measured and not billed", () => {
		expect(
			deliveryJson({
				seconds: 90,
				secondsByTier: {
					"360p": 0,
					"720p": 0,
					"1080p": 90,
					"1440p": 0,
					"2160p": 0,
				},
			}),
		).toEqual({
			minutes: 1.5,
			minutesByTier: {
				"360p": 0,
				"720p": 0,
				"1080p": 1.5,
				"1440p": 0,
				"2160p": 0,
			},
			measured: true,
			billed: false,
		});
		expect(deliveryJson(null)).toBeNull();
	});

	it("recognises the missing table code at any depth", () => {
		expect(isMissingTableError({ errno: 1146 })).toBe(true);
		expect(isMissingTableError({ code: "ER_NO_SUCH_TABLE" })).toBe(true);
		expect(isMissingTableError({ cause: { cause: { errno: 1146 } } })).toBe(
			true,
		);
		expect(isMissingTableError({ errno: 1205 })).toBe(false);
		expect(isMissingTableError(null)).toBe(false);
	});
});
