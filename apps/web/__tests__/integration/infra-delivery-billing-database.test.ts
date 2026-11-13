import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
} from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	scheduleAutoTopUp: vi.fn(async (_target: { accountId: string }) => {}),
}));

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
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {},
}));
vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/utils", () => ({ userIsPro: () => false }));
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => null }),
	headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@/lib/infra-auto-top-up", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-auto-top-up")>()),
	scheduleAutoTopUp: fixture.scheduleAutoTopUp,
}));

const { addCreditsToAccount } = await import("@/lib/developer-credits");
const { emptyStorageMinutes } = await import("@/lib/developer-pricing");
const { getInfraBilling } = await import("@/lib/infra-standing");
const { chargeStorageDay } = await import("@/lib/infra-storage-billing");
const { chargeDeliveryDay, deliveryBillingStart, settleDeliveryDays } =
	await import("@/lib/infra-delivery-billing");
await import("@/lib/infra-auto-top-up");
const { describeLedgerRow } = await import("@/lib/infra-ledger");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;
const dayKey = (daysAgo: number, from = new Date()) =>
	new Date(from.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);

// 3000 s at 1080p and 1234 s at 720p are 4234 delivered seconds, 70.57
// minutes. At $0.95 per 1,000 minutes and 100,000 micro-credits per dollar
// that is 4234 * 95 / 60 = 6703.83, floored to 6703 micro-credits.
const FIXTURE_TIERS = [
	{ tier: "1080p", seconds: 3000, bytes: 900_000_000, requests: 500 },
	{ tier: "720p", seconds: 1234, bytes: 200_000_000, requests: 206 },
	{ tier: "audio", seconds: 0, bytes: 40_000_000, requests: 706 },
];
const FIXTURE_MICRO_CREDITS = 6703;

describe.runIf(Boolean(databaseUrl))(
	"delivery debit against a real database",
	() => {
		let pool: Pool;

		const makeApp = async (balanceMicroCredits: number) => {
			const appId = id();
			const accountId = id();
			const ownerId = id() as never;
			await database().insert(developerApps).values({
				id: appId,
				ownerId,
				name: "Delivery fixture",
				environment: "development",
			});
			await database().insert(developerCreditAccounts).values({
				id: accountId,
				appId,
				ownerId,
				balanceMicroCredits,
			});
			return { appId, accountId };
		};

		const writeDay = async (
			appId: string,
			day: string,
			tiers: {
				tier: string;
				seconds: number;
				bytes?: number;
				requests?: number;
			}[],
			final = true,
		) => {
			await pool.query(
				"delete from developer_delivery_daily where appId = ? and day = ?",
				[appId, day],
			);
			for (const row of tiers) {
				await pool.query(
					"insert into developer_delivery_daily (appId, day, tier, seconds, bytes, requests, updatedAt, final, finalizedAt) values (?, ?, ?, ?, ?, ?, now(), ?, if(?, now(), null))",
					[
						appId,
						day,
						row.tier,
						row.seconds,
						row.bytes ?? 0,
						row.requests ?? 0,
						final,
						final,
					],
				);
			}
		};

		const deliveryRows = (accountId: string) =>
			database()
				.select()
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.type, "delivery_daily"),
					),
				);

		const balanceOf = async (accountId: string) => {
			const [row] = await database()
				.select({ balance: developerCreditAccounts.balanceMicroCredits })
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, accountId));
			return row?.balance;
		};

		const settle = (now = new Date(), startDay: string | null = "2000-01-01") =>
			settleDeliveryDays({ now, startDay });

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error(
					"Delivery tests require a session-scoped local database.",
				);
			}
			pool = createPool({ uri: databaseUrl, connectionLimit: 8 });
			fixture.database = drizzle(pool);
			await pool.query(
				"create table if not exists developer_delivery_daily (appId varchar(15) not null, day date not null, tier varchar(8) not null, seconds bigint not null default 0, bytes bigint not null default 0, requests int not null default 0, updatedAt timestamp not null, final boolean not null default false, finalizedAt timestamp null, primary key (appId, day, tier))",
			);
		});

		beforeEach(async () => {
			await pool.query("delete from developer_delivery_daily");
			fixture.scheduleAutoTopUp.mockClear();
		});

		afterAll(async () => {
			await pool?.query("drop table if exists developer_delivery_daily");
			await pool?.end();
		});

		it("debits nothing and writes no row while the flag is off", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			await writeDay(appId, dayKey(2), FIXTURE_TIERS);

			for (const value of [
				undefined,
				"",
				"  ",
				"true",
				"2026-13-01",
				"2026-02-30",
			]) {
				const startDay = deliveryBillingStart(value);
				expect(startDay).toBeNull();
				const sweep = await settle(new Date(), startDay);
				expect(sweep).toMatchObject({ enabled: false, billed: 0 });
			}

			expect(await deliveryRows(accountId)).toEqual([]);
			expect(await balanceOf(accountId)).toBe(1_000_000);
			expect(fixture.scheduleAutoTopUp).not.toHaveBeenCalled();
		});

		it("writes one row per app per final day with the exact micro-credit amount and the per tier minutes", async () => {
			const now = new Date();
			const first = await makeApp(1_000_000);
			const second = await makeApp(1_000_000);
			for (const app of [first, second]) {
				await writeDay(app.appId, dayKey(2, now), FIXTURE_TIERS);
				await writeDay(app.appId, dayKey(3, now), FIXTURE_TIERS);
			}

			const sweep = await settle(now);

			expect(sweep).toMatchObject({
				enabled: true,
				tableReady: true,
				billed: 4,
			});
			for (const app of [first, second]) {
				const rows = await deliveryRows(app.accountId);
				expect(rows.map((row) => row.referenceId).sort()).toEqual([
					dayKey(3, now),
					dayKey(2, now),
				]);
				for (const row of rows) {
					expect(row).toMatchObject({
						amountMicroCredits: -FIXTURE_MICRO_CREDITS,
						referenceType: "delivery_day",
					});
					expect(row.metadata).toMatchObject({
						deliveryDate: row.referenceId,
						owedMicroCredits: FIXTURE_MICRO_CREDITS,
						chargedMicroCredits: FIXTURE_MICRO_CREDITS,
						shortSince: null,
						fellShort: false,
						deliveredSeconds: 4234,
						minutesByTier: { "1080p": 50, "720p": 20.57 },
						microCreditsPer1000Minutes: 95_000,
					});
					const day = new Date(`${row.referenceId}T00:00:00Z`);
					expect(describeLedgerRow(row)).toEqual({
						label: `Delivery, ${day.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
						note: "70.57 minutes delivered (1080p 50, 720p 20.57).",
						reference: { kind: "Day", value: row.referenceId },
					});
				}
				expect(await balanceOf(app.accountId)).toBe(
					1_000_000 - 2 * FIXTURE_MICRO_CREDITS,
				);
			}
		});

		it("never settles today, yesterday, a day older than the window or a day before the start day", async () => {
			const now = new Date();
			const { appId, accountId } = await makeApp(1_000_000);
			for (const daysAgo of [0, 1, 4, 9]) {
				await writeDay(appId, dayKey(daysAgo, now), FIXTURE_TIERS);
			}
			await writeDay(appId, dayKey(3, now), FIXTURE_TIERS);

			expect(await settle(now, dayKey(2, now))).toMatchObject({ billed: 0 });
			expect(await deliveryRows(accountId)).toEqual([]);
		});

		it("charges a day once however many times the sweep runs, including runs at the same time", async () => {
			const now = new Date();
			const { appId, accountId } = await makeApp(1_000_000);
			await writeDay(appId, dayKey(2, now), FIXTURE_TIERS);

			const runs = await Promise.all([settle(now), settle(now), settle(now)]);
			await settle(now);
			await settle(new Date(now.getTime() + DAY_MS));

			expect(runs.reduce((sum, run) => sum + run.billed, 0)).toBe(1);
			expect(await deliveryRows(accountId)).toHaveLength(1);
			expect(await balanceOf(accountId)).toBe(
				1_000_000 - FIXTURE_MICRO_CREDITS,
			);
		});

		it("waits until every row of the day is final, charges the final total once, and ignores any later rewrite", async () => {
			const now = new Date();
			const day = dayKey(2, now);
			const { appId, accountId } = await makeApp(1_000_000);
			await writeDay(appId, day, [{ tier: "1080p", seconds: 600 }], false);

			expect(await settle(now)).toMatchObject({ billed: 0, waiting: 1 });
			expect(await deliveryRows(accountId)).toEqual([]);

			await writeDay(appId, day, FIXTURE_TIERS);
			await pool.query(
				"update developer_delivery_daily set final = false, finalizedAt = null where appId = ? and tier = 'audio'",
				[appId],
			);
			expect(await settle(now)).toMatchObject({ billed: 0, waiting: 1 });
			expect(await deliveryRows(accountId)).toEqual([]);

			await writeDay(appId, day, FIXTURE_TIERS);
			expect(await settle(now)).toMatchObject({ billed: 1, waiting: 0 });

			await writeDay(appId, day, [{ tier: "1080p", seconds: 90_000 }]);
			expect(await settle(now)).toMatchObject({ billed: 0 });
			expect(await settle(new Date(now.getTime() + DAY_MS))).toMatchObject({
				billed: 0,
			});

			const rows = await deliveryRows(accountId);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.amountMicroCredits).toBe(-FIXTURE_MICRO_CREDITS);
			expect(await balanceOf(accountId)).toBe(
				1_000_000 - FIXTURE_MICRO_CREDITS,
			);
		});

		it("returns the exact rows a real run writes from a dry run, twice the same, and writes nothing", async () => {
			const now = new Date();
			const rich = await makeApp(1_000_000);
			const poor = await makeApp(9_000);
			for (const app of [rich, poor]) {
				await writeDay(app.appId, dayKey(3, now), FIXTURE_TIERS);
				await writeDay(app.appId, dayKey(2, now), FIXTURE_TIERS);
			}
			const ledgerCount = async () => {
				const [rows] = await pool.query(
					"select count(*) as count from developer_credit_transactions where accountId in (?, ?)",
					[rich.accountId, poor.accountId],
				);
				return Number((rows as { count: number }[])[0]?.count);
			};

			const first = await settleDeliveryDays({
				now,
				startDay: "2000-01-01",
				dryRun: true,
			});
			const second = await settleDeliveryDays({
				now,
				startDay: "2000-01-01",
				dryRun: true,
			});

			expect(await ledgerCount()).toBe(0);
			expect(await balanceOf(rich.accountId)).toBe(1_000_000);
			expect(await balanceOf(poor.accountId)).toBe(9_000);
			expect(fixture.scheduleAutoTopUp).not.toHaveBeenCalled();
			expect(second.planned).toEqual(first.planned);
			expect(first).toMatchObject({ dryRun: true, billed: 4, short: 1 });
			const poorPlan = first.planned.filter((row) => row.appId === poor.appId);
			expect(poorPlan.map((row) => row.amountMicroCredits)).toEqual([
				-FIXTURE_MICRO_CREDITS,
				-(9_000 - FIXTURE_MICRO_CREDITS),
			]);

			await settle(now);
			const written = [
				...(await deliveryRows(rich.accountId)),
				...(await deliveryRows(poor.accountId)),
			].map((row) => ({
				accountId: row.accountId,
				referenceId: row.referenceId,
				amountMicroCredits: row.amountMicroCredits,
				balanceAfterMicroCredits: row.balanceAfterMicroCredits,
				metadata: row.metadata,
			}));
			const byKey = (
				a: { accountId: string; referenceId: string | null },
				b: { accountId: string; referenceId: string | null },
			) =>
				`${a.accountId}:${a.referenceId}`.localeCompare(
					`${b.accountId}:${b.referenceId}`,
				);
			const planned = first.planned
				.map(({ appId: _appId, ...row }) => row)
				.sort(byKey);
			expect(written.sort(byKey)).toEqual(planned);
			expect(written).toHaveLength(planned.length);
		});

		it("puts the app in grace exactly as a storage day the balance cannot pay", async () => {
			const now = new Date();
			const delivery = await makeApp(1_000);
			const storage = await makeApp(1_000);
			await writeDay(delivery.appId, dayKey(2, now), FIXTURE_TIERS);
			const fellShort: unknown[] = [];

			await settleDeliveryDays({
				now,
				startDay: "2000-01-01",
				onFellShort: async (shortfall) => {
					fellShort.push(shortfall);
				},
			});
			const storageResult = await chargeStorageDay({
				appId: storage.appId,
				accountId: storage.accountId,
				usage: {
					videoCount: 1,
					totalMinutes: 1,
					minutesByTier: emptyStorageMinutes(),
					monthlyMicroCredits: FIXTURE_MICRO_CREDITS * 30,
					dailyMicroCredits: FIXTURE_MICRO_CREDITS,
				},
				dateKey: dayKey(0, now),
				now,
			});

			const [row] = await deliveryRows(delivery.accountId);
			expect(row).toMatchObject({
				amountMicroCredits: -1_000,
				balanceAfterMicroCredits: 0,
			});
			expect(row?.metadata).toMatchObject({
				owedMicroCredits: FIXTURE_MICRO_CREDITS,
				chargedMicroCredits: 1_000,
				shortSince: now.toISOString(),
				fellShort: true,
			});
			expect(storageResult).toMatchObject({
				state: "billed",
				chargedMicroCredits: 1_000,
				shortSince: now,
				fellShort: true,
			});
			expect(fellShort).toEqual([
				{
					accountId: delivery.accountId,
					dateKey: dayKey(2, now),
					shortSince: now,
				},
			]);
			const deliveryStanding = (await getInfraBilling(delivery.appId)).standing;
			const storageStanding = (await getInfraBilling(storage.appId)).standing;
			expect(deliveryStanding).toEqual({
				state: "grace",
				pausesAt: new Date(now.getTime() + 7 * DAY_MS),
			});
			expect(deliveryStanding).toEqual(storageStanding);
			expect(describeLedgerRow(row as never).note).toBe(
				"70.57 minutes delivered (1080p 50, 720p 20.57). The balance paid for part of this day. The rest is not charged later.",
			);

			for (const app of [delivery, storage]) {
				await addCreditsToAccount({
					accountId: app.accountId,
					amountCents: 7,
					referenceId: id(),
					referenceType: "stripe_payment_intent",
				});
				expect((await getInfraBilling(app.appId)).standing).toEqual({
					state: "active",
					pausesAt: null,
				});
			}
		});

		it("carries a storage shortfall's grace start through an unpaid delivery day, and latches it when the balance covers it", async () => {
			const now = new Date();
			const shortSince = new Date(now.getTime() - 3 * DAY_MS);
			const { appId, accountId } = await makeApp(500);
			await chargeStorageDay({
				appId,
				accountId,
				usage: {
					videoCount: 1,
					totalMinutes: 1,
					minutesByTier: emptyStorageMinutes(),
					monthlyMicroCredits: 30_000,
					dailyMicroCredits: 1_000,
				},
				dateKey: dayKey(3, now),
				now: shortSince,
			});
			await writeDay(appId, dayKey(2, now), FIXTURE_TIERS);

			expect(await settle(now)).toMatchObject({ billed: 0, unpaid: 1 });
			expect(await deliveryRows(accountId)).toEqual([]);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "grace",
				pausesAt: new Date(shortSince.getTime() + 7 * DAY_MS),
			});

			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 50_000 })
				.where(eq(developerCreditAccounts.id, accountId));
			expect(await settle(now)).toMatchObject({ billed: 1, short: 0 });

			const [row] = await deliveryRows(accountId);
			expect(row?.metadata).toMatchObject({
				shortSince: null,
				fellShort: false,
			});
			const [storageRow] = await database()
				.select({ metadata: developerCreditTransactions.metadata })
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.type, "storage_daily"),
					),
				);
			expect(storageRow?.metadata).toMatchObject({
				shortSince: shortSince.toISOString(),
				resolvedAt: now.toISOString(),
			});
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("carries an open storage shortfall's start into a delivery day it can only part pay, without a second email", async () => {
			const now = new Date();
			const shortSince = new Date(now.getTime() - 2 * DAY_MS);
			const { appId, accountId } = await makeApp(500);
			await chargeStorageDay({
				appId,
				accountId,
				usage: {
					videoCount: 1,
					totalMinutes: 1,
					minutesByTier: emptyStorageMinutes(),
					monthlyMicroCredits: 30_000,
					dailyMicroCredits: 1_000,
				},
				dateKey: dayKey(3, now),
				now: shortSince,
			});
			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 300 })
				.where(eq(developerCreditAccounts.id, accountId));
			await writeDay(appId, dayKey(2, now), FIXTURE_TIERS);
			const fellShort: unknown[] = [];

			await settleDeliveryDays({
				now,
				startDay: "2000-01-01",
				onFellShort: async (shortfall) => {
					fellShort.push(shortfall);
				},
			});

			const [row] = await deliveryRows(accountId);
			expect(row).toMatchObject({
				amountMicroCredits: -300,
				balanceAfterMicroCredits: 0,
			});
			expect(row?.metadata).toMatchObject({
				owedMicroCredits: FIXTURE_MICRO_CREDITS,
				shortSince: shortSince.toISOString(),
				fellShort: false,
			});
			expect(fellShort).toEqual([]);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "grace",
				pausesAt: new Date(shortSince.getTime() + 7 * DAY_MS),
			});
		});

		it("resolves a delivery shortfall with the rest of its rows once a released hold covers it", async () => {
			const now = new Date();
			const { appId, accountId } = await makeApp(10_000);
			const holdId = id();
			await database().insert(developerTranscripts).values({
				id: holdId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 9_000,
			});
			await writeDay(appId, dayKey(2, now), FIXTURE_TIERS);
			await settle(now);

			const [short] = await deliveryRows(accountId);
			expect(short).toMatchObject({
				amountMicroCredits: -1_000,
				balanceAfterMicroCredits: 9_000,
			});
			expect(short?.metadata).toMatchObject({ shortSince: now.toISOString() });
			expect((await getInfraBilling(appId)).standing.state).toBe("grace");

			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, holdId));
			const later = new Date(now.getTime() + 60_000);
			await chargeStorageDay({
				appId,
				accountId,
				usage: {
					videoCount: 1,
					totalMinutes: 1,
					minutesByTier: emptyStorageMinutes(),
					monthlyMicroCredits: 3_000,
					dailyMicroCredits: 100,
				},
				dateKey: dayKey(0, now),
				now: later,
			});

			const [resolved] = await deliveryRows(accountId);
			expect(resolved?.metadata).toMatchObject({
				shortSince: now.toISOString(),
				resolvedAt: later.toISOString(),
			});
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("debits nothing and does not throw while the rollup table, or its final column, does not exist", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			await writeDay(appId, dayKey(2), FIXTURE_TIERS);
			await pool.query(
				"rename table developer_delivery_daily to developer_delivery_daily_parked",
			);
			try {
				expect(await settle()).toMatchObject({
					enabled: true,
					tableReady: false,
					billed: 0,
					failed: 0,
				});
				await pool.query(
					"create table developer_delivery_daily (appId varchar(15) not null, day date not null, tier varchar(8) not null, seconds bigint not null default 0, bytes bigint not null default 0, requests int not null default 0, updatedAt timestamp not null, primary key (appId, day, tier))",
				);
				await pool.query(
					"insert into developer_delivery_daily (appId, day, tier, seconds, updatedAt) values (?, ?, '1080p', 3000, now())",
					[appId, dayKey(2)],
				);
				expect(await settle()).toMatchObject({
					enabled: true,
					tableReady: false,
					billed: 0,
					failed: 0,
				});
			} finally {
				await pool.query("drop table if exists developer_delivery_daily");
				await pool.query(
					"rename table developer_delivery_daily_parked to developer_delivery_daily",
				);
			}
			expect(await deliveryRows(accountId)).toEqual([]);
			expect(await balanceOf(accountId)).toBe(1_000_000);
		});

		it("schedules one auto top-up after an account's charged days, and none when nothing was charged", async () => {
			const now = new Date();
			const paying = await makeApp(1_000_000);
			const empty = await makeApp(0);
			for (const app of [paying, empty]) {
				await writeDay(app.appId, dayKey(2, now), FIXTURE_TIERS);
				await writeDay(app.appId, dayKey(3, now), FIXTURE_TIERS);
			}

			await settle(now);
			await settle(now);

			expect(fixture.scheduleAutoTopUp.mock.calls).toEqual([
				[{ accountId: paying.accountId }],
			]);
			expect(await deliveryRows(empty.accountId)).toHaveLength(1);
		});

		it("skips a deleted app and leaves a day with no video minutes alone", async () => {
			const now = new Date();
			const deleted = await makeApp(1_000_000);
			const audioOnly = await makeApp(1_000_000);
			await database()
				.update(developerApps)
				.set({ deletedAt: new Date() })
				.where(eq(developerApps.id, deleted.appId));
			await writeDay(deleted.appId, dayKey(2, now), FIXTURE_TIERS);
			await writeDay(audioOnly.appId, dayKey(2, now), [
				{ tier: "audio", seconds: 0, bytes: 5_000 },
			]);

			expect(await settle(now)).toMatchObject({ billed: 0 });
			expect(await deliveryRows(deleted.accountId)).toEqual([]);
			expect(await deliveryRows(audioOnly.accountId)).toEqual([]);
		});

		it("charges a single day directly with the same rules the sweep uses", async () => {
			const { appId, accountId } = await makeApp(10_000);
			const result = await chargeDeliveryDay({
				appId,
				accountId,
				delivered: {
					day: "2026-11-10",
					seconds: 4234,
					secondsByTier: { "1080p": 3000, "720p": 1234 },
				},
				now: new Date(),
			});
			expect(result).toMatchObject({
				state: "billed",
				owedMicroCredits: FIXTURE_MICRO_CREDITS,
				chargedMicroCredits: FIXTURE_MICRO_CREDITS,
				balanceMicroCredits: 10_000 - FIXTURE_MICRO_CREDITS,
			});
			const [rows] = await pool.query(
				"select count(*) as count from developer_credit_transactions where accountId = ?",
				[accountId],
			);
			expect(Number((rows as { count: number }[])[0]?.count)).toBe(1);
		});
	},
);
