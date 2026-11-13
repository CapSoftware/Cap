import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const fixture = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true", NEXT_PUBLIC_WEB_URL: "https://web" },
	serverEnv: () => ({ WEB_URL: "https://web" }),
}));
vi.mock("@/lib/infra-pricing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-pricing")>()),
	INFRA_DELIVERY_BILLED_FROM: "2000-01-01",
}));
vi.mock("@/lib/infra-storage", () => ({
	getStorageUsageByApp: async () => new Map(),
}));
vi.mock("@/lib/infra-storage-billing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-storage-billing")>()),
	chargeStorageDay: async () => ({ state: "skipped" }),
	recordStorageDayVisits: async () => {},
}));
vi.mock("@/lib/infra-storage-minimum", () => ({
	chargeMissedFirstMonths: async () => ({ charged: 0, short: 0, failed: 0 }),
	shortfallsAwaitingNotice: async () => new Map(),
	openFirstMonthShortfalls: async () => new Set(),
	markShortfallsNotified: async () => {},
	markStorageDayNotified: async () => {},
}));
vi.mock("@/lib/infra-auto-top-up", () => ({
	runDueAutoTopUps: async () => ({ attempted: 0, succeeded: 0, failed: 0 }),
	scheduleAutoTopUp: async () => {},
}));
vi.mock("@/lib/infra-billing-emails", () => ({
	sendInfraOutOfCreditEmail: async () => false,
}));

const { GET } = await import("@/app/api/cron/developer-storage/route");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const CRON_SECRET = "delivery-cron-test-secret";
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;
const dayKey = (daysAgo: number) =>
	new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);

const ROLLUP_TABLE =
	"create table developer_delivery_daily (appId varchar(15) not null, day date not null, tier varchar(8) not null, seconds bigint not null default 0, bytes bigint not null default 0, requests int not null default 0, abandonedBytes bigint not null default 0, final boolean not null default false, finalizedAt timestamp null, updatedAt timestamp not null, primary key (appId, day, tier), index day_idx (day))";

describe.runIf(Boolean(databaseUrl))(
	"the storage cron's delivery debit against a real database",
	() => {
		let pool: Pool;
		const fixtureApps: string[] = [];

		const makeApp = async () => {
			const appId = id();
			const accountId = id();
			const ownerId = id() as never;
			fixtureApps.push(appId);
			await database().insert(developerApps).values({
				id: appId,
				ownerId,
				name: "Delivery cron fixture",
				environment: "development",
			});
			await database().insert(developerCreditAccounts).values({
				id: accountId,
				appId,
				ownerId,
				balanceMicroCredits: 1_000_000,
			});
			for (const daysAgo of [5, 4, 3, 2]) {
				await pool.query(
					"insert into developer_delivery_daily (appId, day, tier, seconds, bytes, requests, updatedAt, final, finalizedAt) values (?, ?, '1080p', 600, 1000, 10, now(), true, now())",
					[appId, dayKey(daysAgo)],
				);
			}
			return { appId, accountId };
		};

		const deliveryDays = async (accountId: string) =>
			(
				await database()
					.select({ day: developerCreditTransactions.referenceId })
					.from(developerCreditTransactions)
					.where(
						and(
							eq(developerCreditTransactions.accountId, accountId),
							eq(developerCreditTransactions.type, "delivery_daily"),
						),
					)
			)
				.map((row) => row.day)
				.sort();

		const runCron = async () => {
			const response = await GET(
				new Request("https://localhost/api/cron/developer-storage", {
					headers: { authorization: `Bearer ${CRON_SECRET}` },
				}),
			);
			expect(response.status).toBe(200);
			return response.json();
		};

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error(
					"Delivery cron tests require a session-scoped local database.",
				);
			}
			process.env.CRON_SECRET = CRON_SECRET;
			pool = createPool({ uri: databaseUrl, connectionLimit: 8 });
			fixture.database = drizzle(pool);
			const [existing] = await pool.query(
				"select count(*) as count from information_schema.tables where table_schema = database() and table_name = 'developer_delivery_daily'",
			);
			if (Number((existing as { count: number }[])[0]?.count) === 0) {
				await pool.query(ROLLUP_TABLE);
			}
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		afterAll(async () => {
			if (fixtureApps.length > 0) {
				await pool?.query(
					"delete from developer_delivery_daily where appId in (?)",
					[fixtureApps],
				);
			}
			if (fixtureApps.length > 0) {
				await database()
					.update(developerApps)
					.set({ deletedAt: new Date() })
					.where(inArray(developerApps.id, fixtureApps));
			}
			await pool?.end();
		});

		it("charges nothing with the start day unset", async () => {
			vi.stubEnv("CAP_INFRA_DELIVERY_BILLING_FROM", "");
			const { accountId } = await makeApp();

			const body = await runCron();

			expect(body.delivery).toMatchObject({ enabled: false, billed: 0 });
			expect(await deliveryDays(accountId)).toEqual([]);
		});

		it("charges final days on and after the start day only, never the days before it", async () => {
			const from = dayKey(2);
			vi.stubEnv("CAP_INFRA_DELIVERY_BILLING_FROM", from);
			const { accountId } = await makeApp();

			const first = await runCron();
			const second = await runCron();

			expect(first.delivery).toMatchObject({ enabled: true, tableReady: true });
			expect(second.delivery).toMatchObject({ billed: 0 });
			expect(await deliveryDays(accountId)).toEqual([from]);
		});

		it("charges nothing while every final day is before the start day", async () => {
			vi.stubEnv("CAP_INFRA_DELIVERY_BILLING_FROM", dayKey(1));
			const { accountId } = await makeApp();

			await runCron();

			expect(await deliveryDays(accountId)).toEqual([]);
		});
	},
);
