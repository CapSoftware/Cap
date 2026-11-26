import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as { tier: string; seconds: unknown; finalThrough: unknown }[],
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
	isDeliveryNotReadyError,
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

	it("returns null while the table has no final column yet", async () => {
		mocks.failure = Object.assign(new Error("Failed query"), {
			cause: Object.assign(new Error("Unknown column 'final'"), {
				code: "ER_BAD_FIELD_ERROR",
				errno: 1054,
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
			{ tier: "720p", seconds: "20160", finalThrough: "2026-11-17" },
			{ tier: "1080p", seconds: "54000", finalThrough: "2026-11-18" },
			{ tier: "360p", seconds: 750, finalThrough: null },
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
			finalThrough: "2026-11-18",
		});
	});

	it("reads one app over the UTC calendar month, on the primary key prefix, without the audio tier", async () => {
		await getDeliveredUsage("app-1", new Date("2026-11-30T23:59:59.999Z"));

		const { sql, params } = query(mocks.where[0]);
		expect(sql).toBe(
			"(`developer_delivery_daily`.`appId` = ? and `developer_delivery_daily`.`day` >= ? and `developer_delivery_daily`.`day` < ? and `developer_delivery_daily`.`tier` <> ?)",
		);
		expect(params).toEqual(["app-1", "2026-11-01", "2026-12-01", "audio"]);
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
				{ tier: "480p", seconds: 600, finalThrough: "2026-11-19" },
				{ tier: "audio", seconds: 0, finalThrough: "2026-11-19" },
				{ tier: "1080p", seconds: null, finalThrough: "not a day" },
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
			finalThrough: null,
		});
		expect(
			sumDeliveryRows([{ tier: "audio", seconds: 0, finalThrough: null }]),
		).toBeNull();
	});

	it("reports minutes for each tier and the last final day, with no audio tier", () => {
		const json = deliveryJson({
			seconds: 90,
			secondsByTier: {
				"360p": 0,
				"720p": 0,
				"1080p": 90,
				"1440p": 0,
				"2160p": 0,
			},
			finalThrough: "2026-11-18",
		});
		expect(json).toEqual({
			minutes: 1.5,
			minutesByTier: {
				"360p": 0,
				"720p": 0,
				"1080p": 1.5,
				"1440p": 0,
				"2160p": 0,
			},
			finalThrough: "2026-11-18",
		});
		expect(Object.keys(json?.minutesByTier ?? {})).not.toContain("audio");
		expect(deliveryJson(null)).toBeNull();
	});

	it("recognises a missing table or column at any depth", () => {
		expect(isDeliveryNotReadyError({ errno: 1146 })).toBe(true);
		expect(isDeliveryNotReadyError({ code: "ER_NO_SUCH_TABLE" })).toBe(true);
		expect(isDeliveryNotReadyError({ errno: 1054 })).toBe(true);
		expect(isDeliveryNotReadyError({ code: "ER_BAD_FIELD_ERROR" })).toBe(true);
		expect(isDeliveryNotReadyError({ cause: { cause: { errno: 1146 } } })).toBe(
			true,
		);
		expect(isDeliveryNotReadyError({ errno: 1205 })).toBe(false);
		expect(isDeliveryNotReadyError(null)).toBe(false);
	});
});
