import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	appId: "",
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@/app/api/utils", () => ({
	withDeveloperSecretAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("developerAppId", fixture.appId);
		c.set("developerKeyType", "secret");
		await next();
	},
}));
vi.mock("@/lib/infra-standing", () => ({
	getInfraBilling: async () => ({
		stored: { videoCount: 0, totalMinutes: 0 },
		storage: { uploadingVideos: 0 },
	}),
	infraBillingJson: () => ({
		standing: { state: "active", pausesAt: null },
		upload: { allowed: true },
	}),
	infraStorageJson: () => ({ dailyMicroCredits: 0 }),
}));
vi.mock("@/lib/developer-transcript-usage", () => ({
	getSpeechUsage: async () => ({
		balanceMicroCredits: 100_000,
		availableMicroCredits: 100_000,
		heldMicroCredits: 0,
		speech: {
			periodStart: "2026-11-01T00:00:00.000Z",
			seconds: 0,
			microCredits: 0,
			transcripts: 0,
		},
	}),
}));

const { app } = await import("@/app/api/developer/v1/[...route]/usage");
const { deliveryJson, getDeliveredUsage } = await import(
	"@/lib/infra-delivery"
);
const { DeliveredMinutes, NO_DELIVERY } = await import(
	"@/app/(infra)/dashboard/infra/_components/delivered-minutes"
);
const { formatMinutes } = await import("@/lib/infra-usage");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;

const CREATE_TABLE_WITHOUT_FINAL = `CREATE TABLE developer_delivery_daily (
	appId varchar(15) NOT NULL,
	day date NOT NULL,
	tier varchar(8) NOT NULL,
	seconds bigint NOT NULL,
	bytes bigint NOT NULL,
	requests int NOT NULL,
	updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (appId, day, tier)
)`;

const CREATE_TABLE = `CREATE TABLE developer_delivery_daily (
	appId varchar(15) NOT NULL,
	day date NOT NULL,
	tier varchar(8) NOT NULL,
	seconds bigint NOT NULL,
	bytes bigint NOT NULL,
	requests int NOT NULL,
	final boolean NOT NULL DEFAULT false,
	finalizedAt timestamp NULL,
	updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (appId, day, tier)
)`;

const usageDelivery = async () => {
	const response = await app.request("/");
	expect(response.status).toBe(200);
	const { data } = (await response.json()) as {
		data: { delivery: unknown };
	};
	return data.delivery;
};

const consoleRows = (delivery: ReturnType<typeof deliveryJson>) => {
	const html = renderToStaticMarkup(
		createElement(DeliveredMinutes, { delivery, monthName: "November" }),
	);
	return [
		...html.matchAll(
			/<tr[^>]*><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><\/tr>/g,
		),
	].map((match) => [match[1], match[2]]);
};

describe.runIf(Boolean(databaseUrl))(
	"delivered minutes against a real database",
	() => {
		let pool: Pool;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			)
				throw new Error("These tests require a session-scoped local database.");
			pool = createPool({ uri: databaseUrl, connectionLimit: 4 });
			fixture.database = drizzle(pool);
			fixture.appId = "deliveryapp0001";
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
			await pool.query("DROP TABLE IF EXISTS developer_delivery_daily");
		});

		afterAll(async () => {
			vi.useRealTimers();
			await pool?.query("DROP TABLE IF EXISTS developer_delivery_daily");
			await pool?.end();
		});

		it("reports no delivery while the table does not exist", async () => {
			await expect(getDeliveredUsage(fixture.appId)).resolves.toBeNull();
			await expect(usageDelivery()).resolves.toBeNull();
			const html = renderToStaticMarkup(
				createElement(DeliveredMinutes, {
					delivery: null,
					monthName: "November",
				}),
			);
			expect(html).toContain(NO_DELIVERY);
		});

		it("reports no delivery while the table has no final column yet", async () => {
			await pool.query(CREATE_TABLE_WITHOUT_FINAL);
			await pool.query(
				"INSERT INTO developer_delivery_daily (appId, day, tier, seconds, bytes, requests) VALUES (?, '2026-11-02', '1080p', 600, 1, 1)",
				[fixture.appId],
			);
			await expect(getDeliveredUsage(fixture.appId)).resolves.toBeNull();
			await expect(usageDelivery()).resolves.toBeNull();
			await pool.query("DROP TABLE developer_delivery_daily");
		});

		it("gives the same minutes in the console and in GET /usage", async () => {
			await pool.query(CREATE_TABLE);
			await pool.query(
				`INSERT INTO developer_delivery_daily (appId, day, tier, seconds, bytes, requests, final, finalizedAt) VALUES
				(?, '2026-11-01', '1080p', 36000, 900000000, 1200, true, '2026-11-03 02:05:00'),
				(?, '2026-11-01', '720p', 7200, 120000000, 300, true, '2026-11-03 02:05:00'),
				(?, '2026-11-01', 'audio', 0, 5000000, 90, true, '2026-11-03 02:05:00'),
				(?, '2026-11-15', '1080p', 18000, 450000000, 600, true, '2026-11-17 02:05:00'),
				(?, '2026-11-19', '360p', 750, 4000000, 40, false, NULL),
				(?, '2026-11-19', '720p', 12960, 210000000, 500, false, NULL),
				(?, '2026-11-19', 'audio', 0, 3000000, 60, false, NULL),
				(?, '2026-10-31', '1080p', 99999, 1, 1, true, '2026-11-02 02:05:00'),
				(?, '2026-12-01', '1080p', 99999, 1, 1, false, NULL),
				('otherapp0000001', '2026-11-18', '1080p', 99999, 1, 1, true, '2026-11-20 02:05:00')`,
				Array(9).fill(fixture.appId),
			);

			const usage = await getDeliveredUsage(fixture.appId);
			expect(usage).toEqual({
				seconds: 74_910,
				secondsByTier: {
					"360p": 750,
					"720p": 20_160,
					"1080p": 54_000,
					"1440p": 0,
					"2160p": 0,
				},
				finalThrough: "2026-11-15",
			});

			const api = await usageDelivery();
			expect(api).toEqual({
				minutes: 1248.5,
				minutesByTier: {
					"360p": 12.5,
					"720p": 336,
					"1080p": 900,
					"1440p": 0,
					"2160p": 0,
				},
				finalThrough: "2026-11-15",
			});
			expect(
				Object.keys((api as { minutesByTier: object }).minutesByTier),
			).not.toContain("audio");

			const shown = consoleRows(deliveryJson(usage));
			const fromApi = api as {
				minutes: number;
				minutesByTier: Record<string, number>;
			};
			expect(shown).toEqual([
				["360p", formatMinutes(fromApi.minutesByTier["360p"] ?? 0)],
				["720p", formatMinutes(fromApi.minutesByTier["720p"] ?? 0)],
				["1080p", formatMinutes(fromApi.minutesByTier["1080p"] ?? 0)],
				["Total", formatMinutes(fromApi.minutes)],
			]);
		});

		it("reads on the primary key", async () => {
			const [plan] = (await pool.query(
				"EXPLAIN SELECT tier, sum(seconds) FROM developer_delivery_daily WHERE appId = ? AND day >= ? AND day < ? AND tier <> 'audio' GROUP BY tier",
				[fixture.appId, "2026-11-01", "2026-12-01"],
			)) as unknown as [{ key: string | null }[]];
			expect(plan[0]?.key).toBe("PRIMARY");
		});
	},
);
