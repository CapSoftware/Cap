import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
	developerVideos,
} from "@cap/database/schema";
import type { DeveloperVideoProcessingState } from "@cap/database/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

process.env.CAP_INFRA_DELIVERY_BILLING_FROM = "2000-01-01";

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
vi.mock("@/workflows/process-developer-video", () => ({
	processDeveloperVideoWorkflow: "workflow",
}));

const { addCreditsToAccount } = await import("@/lib/developer-credits");
const { emptyStorageMinutes, firstMonthStorageMicroCredits } = await import(
	"@/lib/developer-pricing"
);
const { getInfraBilling, getInfraUploadAdmission } = await import(
	"@/lib/infra-standing"
);
const { getAppStorage, getStorageUsageByApp } = await import(
	"@/lib/infra-storage"
);
const { chargeStorageDay } = await import("@/lib/infra-storage-billing");
const { restoredSinceCharge } = await import("@/lib/infra-standing");
const { chargeDeliveryDay } = await import("@/lib/infra-delivery-billing");
const { deliveryMicroCredits } = await import("@/lib/infra-delivery-rollup");
const { clearFirstMonthChargesBeganCache, firstMonthChargesBegan } =
	await import("@/lib/infra-first-month-start");
const {
	chargeDeveloperVideoFirstMonth,
	chargeMissedFirstMonths,
	settleFirstMonthAtDelete,
	settleFirstMonthAtReady,
	shortfallsAwaitingNotice,
	markShortfallsNotified,
	markStorageDayNotified,
	openFirstMonthShortfalls,
} = await import("@/lib/infra-storage-minimum");
const { recordAdmittedInfraUpload } = await import("@/lib/infra-video-upload");
const {
	beginPart,
	createDeveloperVideoProcessingState,
	markPartDispatched,
	releasePart,
	settlePart,
} = await import("@/lib/developer-video-state");
const { getInfraFirstMonthChargesSince, getInfraStorageChargesSince } =
	await import("@/app/(infra)/dashboard/infra/infra-data");
const { getCurrentUser } = await import("@cap/database/auth/session");
const { deleteDeveloperApp } = await import("@/actions/developers/delete-app");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;
const day = (key: string, time = "00:41:00") => new Date(`${key}T${time}.000Z`);

const processing = (): DeveloperVideoProcessingState => ({
	encodeId: "encode-1",
	startedAt: Date.parse("2026-11-12T00:00:00Z"),
	probe: { duration: 600, width: 1920, height: 1080, fps: 30 },
	hls: { state: "pending" },
	mp4: { state: "complete", output: "out" },
	attempts: { hls: 0, mp4: 1 },
	unavailableChecks: 0,
	poster: null,
	bytes: { source: 1, hls: 0, mp4: 1, poster: 0 },
});

describe.runIf(Boolean(databaseUrl))(
	"first month of storage against a real database",
	() => {
		let pool: Pool;

		const makeApp = async (balanceMicroCredits: number) => {
			const appId = id();
			const accountId = id();
			const ownerId = id() as never;
			await database().insert(developerApps).values({
				id: appId,
				ownerId,
				name: "First month fixture",
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

		const makeVideo = async (
			appId: string,
			overrides: Partial<typeof developerVideos.$inferInsert> = {},
		) => {
			const videoId = id();
			await database()
				.insert(developerVideos)
				.values({
					id: videoId,
					appId,
					name: "Fixture",
					status: "ready",
					duration: 600,
					width: 1920,
					height: 1080,
					maxResolutionTier: "1080p",
					processing: processing(),
					createdAt: new Date("2026-11-12T00:00:00Z"),
					updatedAt: new Date("2026-11-12T00:05:00Z"),
					...overrides,
				});
			return videoId;
		};

		const balanceOf = async (accountId: string) => {
			const [row] = await database()
				.select({ balance: developerCreditAccounts.balanceMicroCredits })
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, accountId));
			return row?.balance;
		};

		const firstMonthRows = (accountId: string) =>
			database()
				.select()
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.type, "video_create"),
					),
				);

		const videoRow = async (videoId: string) => {
			const [row] = await database()
				.select()
				.from(developerVideos)
				.where(eq(developerVideos.id, videoId));
			return row;
		};

		const billDay = (accountId: string, dateKey: string) =>
			database()
				.insert(developerCreditTransactions)
				.values({
					id: id(),
					accountId,
					type: "storage_daily",
					amountMicroCredits: 0,
					balanceAfterMicroCredits: 0,
					referenceId: dateKey,
					referenceType: "storage_day",
					metadata: { snapshotDate: dateKey, owedMicroCredits: 0 },
				});

		const dailyMinutes = async (appId: string, at: Date) =>
			(
				await getStorageUsageByApp([appId], undefined, undefined, {
					dailyChargeAt: at,
				})
			).get(appId)?.totalMinutes ?? 0;

		beforeEach(() => {
			clearFirstMonthChargesBeganCache();
		});

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_(infra|speech)_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error(
					"First month tests require a session-scoped local database.",
				);
			}
			pool = createPool({ uri: databaseUrl, connectionLimit: 12 });
			fixture.database = drizzle(pool);
			await database().select().from(developerVideos).limit(1);
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("debits one month at the video's tier and measured length, once, and marks it paid", async () => {
			const cases = [
				{ seconds: 600, width: 1920, height: 1080, tier: "1080p", owed: 850 },
				{
					seconds: 3600,
					width: 3840,
					height: 2160,
					tier: "2160p",
					owed: 16_800,
				},
				{
					seconds: 3600,
					width: 3840,
					height: 2160,
					tier: "1080p",
					owed: 5_100,
				},
				{ seconds: 600, width: 2560, height: 1440, tier: "1440p", owed: 1_450 },
				{ seconds: 1, width: 640, height: 360, tier: "1080p", owed: 1 },
			] as const;
			for (const video of cases) {
				const { appId, accountId } = await makeApp(1_000_000);
				const videoId = await makeVideo(appId, {
					duration: video.seconds,
					width: video.width,
					height: video.height,
					maxResolutionTier: video.tier,
				});
				const before = await videoRow(videoId);

				const result = await chargeDeveloperVideoFirstMonth(videoId, {
					now: new Date("2026-11-12T10:00:00Z"),
				});

				expect(result).toMatchObject({
					state: "charged",
					owedMicroCredits: video.owed,
					chargedMicroCredits: video.owed,
					shortSince: null,
				});
				expect(video.owed).toBe(
					firstMonthStorageMicroCredits({
						durationSeconds: video.seconds,
						tier: result.state === "charged" ? result.tier : "1080p",
					}),
				);
				expect(await balanceOf(accountId)).toBe(1_000_000 - video.owed);
				const rows = await firstMonthRows(accountId);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					amountMicroCredits: -video.owed,
					balanceAfterMicroCredits: 1_000_000 - video.owed,
					referenceId: videoId,
					referenceType: "developer_video",
				});
				const after = await videoRow(videoId);
				expect(after?.storagePaidUntil).toEqual(
					new Date("2026-12-12T00:00:00Z"),
				);
				expect(after?.updatedAt).toEqual(before?.updatedAt);
				expect(after?.status).toBe("ready");

				expect(
					await chargeDeveloperVideoFirstMonth(videoId, {
						now: new Date("2026-11-12T11:00:00Z"),
					}),
				).toEqual({ state: "skipped", reason: "already_settled" });
				expect(await firstMonthRows(accountId)).toHaveLength(1);
				expect(await balanceOf(accountId)).toBe(1_000_000 - video.owed);
			}
		});

		it("charges the month on the duration stored at first ready, not on what the client first claimed or the probe state", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			const videoId = await makeVideo(appId, {
				status: "processing",
				duration: 4 * 60 * 60,
				processing: {
					...processing(),
					probe: { duration: 4 * 60 * 60, width: 1920, height: 1080, fps: 30 },
				},
			});
			await database()
				.update(developerVideos)
				.set({ duration: 60 })
				.where(eq(developerVideos.id, videoId));
			await database()
				.update(developerVideos)
				.set({ status: "ready" })
				.where(eq(developerVideos.id, videoId));

			await settleFirstMonthAtReady({ id: videoId, deletedAt: null });

			const [row] = await firstMonthRows(accountId);
			expect(row).toMatchObject({ amountMicroCredits: -85 });
			expect(row?.metadata).toMatchObject({
				owedMicroCredits: 85,
				durationSeconds: 60,
			});
			expect(await balanceOf(accountId)).toBe(1_000_000 - 85);
		});

		it("charges once when the ready transition and the backstop race for the same video", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			const videoId = await makeVideo(appId);

			const results = await Promise.all(
				Array.from({ length: 8 }, () =>
					chargeDeveloperVideoFirstMonth(videoId, {
						now: new Date("2026-11-12T10:00:00Z"),
					}),
				),
			);

			expect(results.filter((r) => r.state === "charged")).toHaveLength(1);
			expect(
				results.filter(
					(r) => r.state === "skipped" && r.reason === "already_settled",
				),
			).toHaveLength(7);
			expect(await firstMonthRows(accountId)).toHaveLength(1);
			expect(await balanceOf(accountId)).toBe(1_000_000 - 850);
		});

		it("leaves the video out of the daily charge for exactly 30 billed days, then charges it daily with no gap", async () => {
			const keys = (from: string, count: number) =>
				Array.from({ length: count }, (_, n) =>
					new Date(Date.parse(`${from}T00:00:00Z`) + n * DAY_MS)
						.toISOString()
						.slice(0, 10),
				);

			const afterTodaysCharge = await makeApp(1_000_000);
			await billDay(afterTodaysCharge.accountId, "2026-11-12");
			const lateVideo = await makeVideo(afterTodaysCharge.appId);
			await chargeDeveloperVideoFirstMonth(lateVideo, {
				now: new Date("2026-11-12T10:00:00Z"),
			});
			const late = await Promise.all(
				keys("2026-11-13", 31).map((key) =>
					dailyMinutes(afterTodaysCharge.appId, day(key)),
				),
			);
			expect(late.slice(0, 30)).toEqual(Array(30).fill(0));
			expect(late[30]).toBe(10);
			expect((await videoRow(lateVideo))?.storagePaidUntil).toEqual(
				new Date("2026-12-13T00:00:00Z"),
			);

			const beforeTodaysCharge = await makeApp(1_000_000);
			const earlyVideo = await makeVideo(beforeTodaysCharge.appId);
			await chargeDeveloperVideoFirstMonth(earlyVideo, {
				now: new Date("2026-11-12T00:10:00Z"),
			});
			const early = await Promise.all(
				keys("2026-11-12", 31).map((key) =>
					dailyMinutes(beforeTodaysCharge.appId, day(key, "06:41:00")),
				),
			);
			expect(early.slice(0, 30)).toEqual(Array(30).fill(0));
			expect(early[30]).toBe(10);

			const charge = async (key: string) =>
				chargeStorageDay({
					appId: beforeTodaysCharge.appId,
					accountId: beforeTodaysCharge.accountId,
					usage:
						(
							await getStorageUsageByApp(
								[beforeTodaysCharge.appId],
								undefined,
								undefined,
								{ dailyChargeAt: day(key) },
							)
						).get(beforeTodaysCharge.appId) ??
						(() => {
							throw new Error("no usage");
						})(),
					dateKey: key,
					now: day(key),
				});
			expect(await charge("2026-12-11")).toEqual({ state: "skipped" });
			expect(await charge("2026-12-12")).toMatchObject({
				state: "billed",
				chargedMicroCredits: Math.floor(850 / 30),
			});
		});

		it("does not charge a day the first month covers when the video turned ready after the day was measured", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			const videoId = await makeVideo(appId);
			const at = new Date();
			const measure = async (executor?: never) =>
				(
					await getStorageUsageByApp([appId], undefined, executor, {
						dailyChargeAt: at,
					})
				).get(appId) ??
				(() => {
					throw new Error("no usage");
				})();
			const stale = await measure();
			expect(stale.totalMinutes).toBe(10);

			await chargeDeveloperVideoFirstMonth(videoId, { now: at });
			const result = await chargeStorageDay({
				appId,
				accountId,
				usage: stale,
				measure: (tx) => measure(tx as never),
				dateKey: at.toISOString().slice(0, 10),
				now: at,
			});

			expect(result).toEqual({ state: "skipped" });
			expect(await balanceOf(accountId)).toBe(1_000_000 - 850);
		});

		it("keeps the month paid for a video deleted an hour after it became ready", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			const videoId = await makeVideo(appId);
			await settleFirstMonthAtReady({ id: videoId, deletedAt: null });
			await database()
				.update(developerVideos)
				.set({ deletedAt: new Date(Date.now() + 60 * 60 * 1000) })
				.where(eq(developerVideos.id, videoId));

			expect(await balanceOf(accountId)).toBe(1_000_000 - 850);
			expect(await firstMonthRows(accountId)).toHaveLength(1);
			expect(await chargeMissedFirstMonths(new Date())).toMatchObject({
				failed: 0,
			});
			expect(await firstMonthRows(accountId)).toHaveLength(1);
			expect(await balanceOf(accountId)).toBe(1_000_000 - 850);
		});

		it("charges nothing for a video that errored or was deleted before it became ready", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			const errored = await makeVideo(appId, { status: "errored" });
			const encoding = await makeVideo(appId, { status: "processing" });
			const deletedFirst = await makeVideo(appId, {
				deletedAt: new Date("2026-11-12T09:00:00Z"),
			});

			expect(await chargeDeveloperVideoFirstMonth(errored)).toEqual({
				state: "skipped",
				reason: "not_ready",
			});
			expect(await chargeDeveloperVideoFirstMonth(encoding)).toEqual({
				state: "skipped",
				reason: "not_ready",
			});
			await settleFirstMonthAtReady({
				id: deletedFirst,
				deletedAt: new Date("2026-11-12T09:00:00Z"),
			});

			const exempt = await videoRow(deletedFirst);
			expect(exempt?.storagePaidUntil).not.toBeNull();
			expect(await firstMonthRows(accountId)).toHaveLength(0);
			expect(await balanceOf(accountId)).toBe(1_000_000);

			await chargeMissedFirstMonths(new Date());
			expect(await firstMonthRows(accountId)).toHaveLength(0);
			expect(await balanceOf(accountId)).toBe(1_000_000);
		});

		it("never charges the minimum for a video that was ready before the feature, or one uploaded before encoding existed", async () => {
			await makeVideo((await makeApp(1_000_000)).appId, {
				createdAt: new Date("2026-11-12T00:00:00Z"),
				storagePaidUntil: new Date("2026-12-12T00:00:00Z"),
			});
			const { appId, accountId } = await makeApp(1_000_000);
			const old = await makeVideo(appId, {
				createdAt: new Date("2026-10-01T00:00:00Z"),
			});
			const legacy = await makeVideo(appId, {
				status: "uploading",
				processing: null,
				playbackId: null,
				createdAt: new Date("2026-11-20T00:00:00Z"),
			});

			await chargeMissedFirstMonths(new Date("2026-11-21T00:41:00Z"));
			await chargeMissedFirstMonths(new Date("2026-11-21T06:41:00Z"));

			expect(await firstMonthRows(accountId)).toHaveLength(0);
			expect(await balanceOf(accountId)).toBe(1_000_000);
			expect((await videoRow(old))?.storagePaidUntil).toBeNull();
			expect((await videoRow(legacy))?.storagePaidUntil).toBeNull();
			expect(await dailyMinutes(appId, day("2026-11-21"))).toBe(10);
		});

		it("lets the cron charge a live ready video the transition missed exactly once, and exempt a deleted one", async () => {
			await makeVideo((await makeApp(1_000_000)).appId, {
				storagePaidUntil: new Date("2026-12-12T00:00:00Z"),
			});
			const { appId, accountId } = await makeApp(1_000_000);
			const missed = await makeVideo(appId, {
				createdAt: new Date("2026-11-20T00:00:00Z"),
			});
			const missedThenDeleted = await makeVideo(appId, {
				createdAt: new Date("2026-11-20T01:00:00Z"),
				deletedAt: new Date("2026-11-20T02:00:00Z"),
			});

			const noEncodeState = await makeVideo(appId, {
				processing: null,
				createdAt: new Date("2026-11-19T00:00:00Z"),
			});
			const noAccount = id();
			await database()
				.insert(developerApps)
				.values({
					id: noAccount,
					ownerId: id() as never,
					name: "No credit account",
					environment: "development",
				});
			const unbillable = await makeVideo(noAccount, {
				createdAt: new Date("2026-11-19T00:00:00Z"),
			});

			await chargeMissedFirstMonths(new Date("2026-11-20T06:41:00Z"), 2);
			await chargeMissedFirstMonths(new Date("2026-11-20T12:41:00Z"), 2);
			await chargeMissedFirstMonths(new Date("2026-11-20T18:41:00Z"), 2);

			expect((await videoRow(noEncodeState))?.storagePaidUntil).not.toBeNull();
			expect((await videoRow(unbillable))?.storagePaidUntil).not.toBeNull();

			const rows = await firstMonthRows(accountId);
			expect(rows.map((row) => row.referenceId)).toEqual([missed]);
			expect(await balanceOf(accountId)).toBe(1_000_000 - 850);
			expect((await videoRow(missed))?.storagePaidUntil).not.toBeNull();
			expect(
				(await videoRow(missedThenDeleted))?.storagePaidUntil,
			).not.toBeNull();
		});

		it("takes what the balance holds when it cannot pay the month, leaves the video ready and the account out of credit until topped up", async () => {
			const part = await makeApp(300);
			const partVideo = await makeVideo(part.appId);
			await settleFirstMonthAtReady({ id: partVideo, deletedAt: null });

			expect(await balanceOf(part.accountId)).toBe(0);
			const [partRow] = await firstMonthRows(part.accountId);
			expect(partRow).toMatchObject({
				amountMicroCredits: -300,
				balanceAfterMicroCredits: 0,
			});
			expect(partRow?.metadata).toMatchObject({
				owedMicroCredits: 850,
				chargedMicroCredits: 300,
			});
			expect(
				(partRow?.metadata as { shortSince: string | null }).shortSince,
			).not.toBeNull();
			const partVideoRow = await videoRow(partVideo);
			expect(partVideoRow?.status).toBe("ready");
			expect(partVideoRow?.storagePaidUntil).not.toBeNull();

			const short = await getInfraBilling(part.appId);
			expect(short.standing.state).toBe("grace");
			expect(short.admission).toMatchObject({
				allowed: false,
				reason: "out_of_credit",
			});

			const unpaid = await makeApp(0);
			await settleFirstMonthAtReady({
				id: await makeVideo(unpaid.appId),
				deletedAt: null,
			});
			const [unpaidRow] = await firstMonthRows(unpaid.accountId);
			expect(unpaidRow).toMatchObject({
				amountMicroCredits: 0,
				balanceAfterMicroCredits: 0,
			});
			expect((await getInfraBilling(unpaid.appId)).standing.state).toBe(
				"grace",
			);

			await addCreditsToAccount({
				accountId: part.accountId,
				amountCents: 1,
				referenceId: id(),
				referenceType: "stripe_payment_intent",
			});
			expect(await balanceOf(part.accountId)).toBe(1_000);
			expect((await getInfraBilling(part.appId)).standing.state).toBe("active");
		});

		it("latches a shortfall once when a released hold covers it, so it never comes back", async () => {
			const { appId, accountId } = await makeApp(900);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 900,
			});
			await settleFirstMonthAtReady({
				id: await makeVideo(appId),
				deletedAt: null,
			});
			const [month] = await firstMonthRows(accountId);
			expect(month).toMatchObject({ amountMicroCredits: 0 });
			expect((await getInfraBilling(appId)).standing.state).toBe("grace");

			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, { duration: 1 }),
				deletedAt: null,
			});
			const latchedRow = async () => {
				const [row] = await database()
					.select({ metadata: developerCreditTransactions.metadata })
					.from(developerCreditTransactions)
					.where(eq(developerCreditTransactions.id, month?.id ?? ""));
				return row?.metadata as {
					resolvedAt?: string;
					owedMicroCredits?: number;
				};
			};
			const first = await latchedRow();
			expect(first.resolvedAt).toEqual(expect.any(String));
			expect(first.owedMicroCredits).toBe(850);

			await settleFirstMonthAtReady({
				id: await makeVideo(appId, { duration: 1 }),
				deletedAt: null,
			});
			expect((await latchedRow()).resolvedAt).toBe(first.resolvedAt);
			expect(await balanceOf(accountId)).toBe(898);

			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 100 })
				.where(eq(developerCreditAccounts.id, accountId));
			const later = await getInfraBilling(
				appId,
				undefined,
				new Date(Date.now() + 10 * DAY_MS),
			);
			expect(later.standing).toEqual({ state: "active", pausesAt: null });
		});

		it("keeps an unpaid month in grace from its first short date when a later, smaller month is paid in full", async () => {
			const { appId, accountId } = await makeApp(900);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 900,
			});
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, {
					duration: 3_600,
					width: 3840,
					height: 2160,
					maxResolutionTier: "2160p",
				}),
				deletedAt: null,
			});
			const [unpaid] = await firstMonthRows(accountId);
			expect(unpaid).toMatchObject({ amountMicroCredits: 0 });
			expect(unpaid?.metadata).toMatchObject({ owedMicroCredits: 16_800 });
			const movedTo = new Date(Math.floor(Date.now() / 1000) * 1000 - 5_000);
			await database()
				.update(developerCreditTransactions)
				.set({ createdAt: movedTo })
				.where(eq(developerCreditTransactions.id, unpaid?.id ?? ""));
			const shortSince = new Date(
				(unpaid?.metadata as { shortSince: string }).shortSince,
			);
			const pausesAt = new Date(shortSince.getTime() + 7 * DAY_MS);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "grace",
				pausesAt,
			});

			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			const paidVideo = await makeVideo(appId);
			await settleFirstMonthAtReady({ id: paidVideo, deletedAt: null });

			const paid = (await firstMonthRows(accountId)).find(
				(row) => row.referenceId === paidVideo,
			);
			expect(paid).toMatchObject({
				amountMicroCredits: -850,
				balanceAfterMicroCredits: 50,
			});
			expect(paid?.metadata).toMatchObject({
				owedMicroCredits: 850,
				chargedMicroCredits: 850,
				outstandingMicroCredits: 16_800,
				shortSince: shortSince.toISOString(),
				fellShort: false,
			});
			expect(paid?.createdAt.getTime()).toBeGreaterThan(movedTo.getTime());
			const billing = await getInfraBilling(appId);
			expect(billing.standing).toEqual({ state: "grace", pausesAt });
			expect(billing.admission).toMatchObject({
				allowed: false,
				reason: "out_of_credit",
			});
			expect(await openFirstMonthShortfalls([accountId])).toEqual(
				new Set([accountId]),
			);
			expect(
				(
					await shortfallsAwaitingNotice(
						[accountId],
						new Date(Date.now() - DAY_MS),
					)
				).get(accountId),
			).toEqual({ shortSince, ids: [unpaid?.id] });

			await addCreditsToAccount({
				accountId,
				amountCents: 17,
				referenceId: id(),
				referenceType: "stripe_payment_intent",
			});
			expect(await balanceOf(accountId)).toBe(17_050);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});

			await database()
				.update(developerCreditTransactions)
				.set({ createdAt: new Date(movedTo.getTime() + 2_000) })
				.where(eq(developerCreditTransactions.id, paid?.id ?? ""));
			const afterVideo = await makeVideo(appId);
			await settleFirstMonthAtReady({ id: afterVideo, deletedAt: null });
			const after = (await firstMonthRows(accountId)).find(
				(row) => row.referenceId === afterVideo,
			);
			expect(after?.metadata).toMatchObject({ shortSince: null });
			expect(after?.metadata).not.toHaveProperty("outstandingMicroCredits");
			expect((await getInfraBilling(appId)).standing.state).toBe("active");
			expect(await openFirstMonthShortfalls([accountId])).toEqual(new Set());
		});

		it("resolves the daily charge a first month shortfall carried when the shortfall is covered", async () => {
			const { appId, accountId } = await makeApp(900);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 900,
			});
			const fourK = {
				duration: 3_600,
				width: 3840,
				height: 2160,
				maxResolutionTier: "2160p" as const,
			};
			await makeVideo(appId, {
				...fourK,
				createdAt: new Date("2026-10-01T00:00:00Z"),
			});
			const today = new Date().toISOString().slice(0, 10);
			const usage = (
				await getStorageUsageByApp([appId], undefined, undefined, {
					dailyChargeAt: new Date(`${today}T00:00:00.000Z`),
				})
			).get(appId);
			if (!usage) throw new Error("no usage");
			const day = await chargeStorageDay({
				appId,
				accountId,
				usage,
				dateKey: today,
				now: new Date(),
			});
			expect(day).toMatchObject({
				state: "billed",
				chargedMicroCredits: 0,
				owedMicroCredits: 560,
			});
			const [dailyRow] = await database()
				.select()
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.type, "storage_daily"),
					),
				);
			const shortSince = (dailyRow?.metadata as { shortSince: string })
				.shortSince;
			expect(shortSince).toEqual(expect.any(String));

			await settleFirstMonthAtReady({
				id: await makeVideo(appId, fourK),
				deletedAt: null,
			});
			const [month] = await firstMonthRows(accountId);
			expect(month?.metadata).toMatchObject({
				owedMicroCredits: 16_800,
				shortSince,
				outstandingMicroCredits: 16_800,
			});

			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 16_800 })
				.where(eq(developerCreditAccounts.id, accountId));
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, fourK),
				deletedAt: null,
			});
			expect(await balanceOf(accountId)).toBe(0);

			const resolvedAt = async (rowId: string) => {
				const [row] = await database()
					.select({ metadata: developerCreditTransactions.metadata })
					.from(developerCreditTransactions)
					.where(eq(developerCreditTransactions.id, rowId));
				return (row?.metadata as { resolvedAt?: string }).resolvedAt;
			};
			expect(await resolvedAt(dailyRow?.id ?? "")).toEqual(expect.any(String));
			expect(await resolvedAt(month?.id ?? "")).toBe(
				await resolvedAt(dailyRow?.id ?? ""),
			);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("resolves the first month a daily latch covers, with the daily rows of the same shortfall", async () => {
			const { appId, accountId } = await makeApp(900);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 900,
			});
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, { duration: 3_600 }),
				deletedAt: null,
			});
			const [month] = await firstMonthRows(accountId);
			const shortSince = (month?.metadata as { shortSince: string }).shortSince;
			expect(month?.metadata).toMatchObject({ owedMicroCredits: 5_100 });

			const dayUsage = (dailyMicroCredits: number) => ({
				videoCount: 1,
				totalMinutes: 1,
				minutesByTier: emptyStorageMinutes(),
				monthlyMicroCredits: dailyMicroCredits * 30,
				dailyMicroCredits,
			});
			const dateKey = (daysAgo: number) =>
				new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
			await database()
				.update(developerTranscripts)
				.set({ reservedMicroCredits: 850 })
				.where(eq(developerTranscripts.id, transcriptId));
			expect(
				await chargeStorageDay({
					appId,
					accountId,
					usage: dayUsage(300),
					dateKey: dateKey(1),
					now: new Date(),
				}),
			).toMatchObject({ state: "billed", chargedMicroCredits: 50 });
			const dailyRows = () =>
				database()
					.select()
					.from(developerCreditTransactions)
					.where(
						and(
							eq(developerCreditTransactions.accountId, accountId),
							eq(developerCreditTransactions.type, "storage_daily"),
						),
					);
			const [carried] = await dailyRows();
			expect(carried?.metadata).toMatchObject({ shortSince });

			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 5_100 })
				.where(eq(developerCreditAccounts.id, accountId));
			expect(
				await chargeStorageDay({
					appId,
					accountId,
					usage: dayUsage(28),
					dateKey: dateKey(0),
					now: new Date(),
				}),
			).toMatchObject({
				state: "billed",
				chargedMicroCredits: 28,
				shortSince: null,
			});

			const resolved = [
				...(await firstMonthRows(accountId)),
				...(await dailyRows()),
			]
				.filter(
					(row) =>
						(row.metadata as { shortSince?: string | null }).shortSince ===
						shortSince,
				)
				.map((row) => (row.metadata as { resolvedAt?: string }).resolvedAt);
			expect(resolved).toHaveLength(2);
			expect(resolved.every((value) => typeof value === "string")).toBe(true);
			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 100 })
				.where(eq(developerCreditAccounts.id, accountId));
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("keeps standing and resolved shortfalls consistent across 500 seeded charge, delivery, hold and top-up sequences", async () => {
			let seed = 0x4145;
			const random = () => {
				seed = (seed + 0x6d2b79f5) | 0;
				let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
			const pick = <T>(items: readonly T[]) =>
				items[Math.floor(random() * items.length)] as T;
			const between = (low: number, high: number) =>
				low + Math.floor(random() * (high - low + 1));
			const kinds = [
				"daily_paid",
				"daily_short",
				"month_paid",
				"month_short",
				"month_short_pair",
				"hold",
				"release",
				"hold",
				"release",
				"top_up",
				"daily_part_in_month",
				"daily_part_in_month",
				"top_up_then_short_same_second",
				"top_up_then_short_same_second",
				"delivery_paid",
				"delivery_short",
				"delivery_paid",
				"delivery_short",
			] as const;
			type Period = { since: string; monthMax: number };
			const failures: string[] = [];
			const delivered = { billed: 0, short: 0, carried: 0 };

			for (let sequence = 0; sequence < 500; sequence++) {
				const startBalance = pick([0, 500, 5_000, 20_000]);
				const { appId, accountId } = await makeApp(startBalance);
				let balance = startBalance;
				let held = 0;
				const holds: { id: string; amount: number }[] = [];
				let period: Period | null = null;
				let lastDaily: { since: string | null; owed: number } = {
					since: null,
					owed: 0,
				};
				const size = () =>
					period
						? Math.max(
								period.monthMax,
								lastDaily.since === period.since ? lastDaily.owed : 0,
							)
						: 0;
				const close = (latch: boolean) => {
					if (!period) return;
					covered.add(period.since);
					if (latch) latched.add(period.since);
					period = null;
					lastDaily = { since: null, owed: 0 };
				};
				const covered = new Set<string>();
				const latched = new Set<string>();
				const steps = between(2, 6);
				const log: string[] = [];
				let dayIndex = 6;
				let deliveryIndex = 40;

				const latch = () => {
					if (period && balance - held >= size()) close(true);
				};
				const topUp = async () => {
					const cents = between(1, 200);
					const referenceId = id();
					await database()
						.update(developerCreditTransactions)
						.set({
							createdAt: sql`${developerCreditTransactions.createdAt} - INTERVAL 1 SECOND`,
						})
						.where(eq(developerCreditTransactions.accountId, accountId));
					await addCreditsToAccount({
						accountId,
						amountCents: cents,
						referenceId,
						referenceType: "stripe_payment_intent",
					});
					const added = Math.floor((cents / 100) * 100_000);
					balance += added;
					log[log.length - 1] += ` +${added}`;
					if (period && balance - held >= size()) close(false);
					const [row] = await database()
						.select({ createdAt: developerCreditTransactions.createdAt })
						.from(developerCreditTransactions)
						.where(
							and(
								eq(developerCreditTransactions.accountId, accountId),
								eq(developerCreditTransactions.referenceId, referenceId),
							),
						);
					return row?.createdAt ?? null;
				};
				const rowSince = async (referenceId: string) => {
					const [row] = await database()
						.select({ metadata: developerCreditTransactions.metadata })
						.from(developerCreditTransactions)
						.where(
							and(
								eq(developerCreditTransactions.accountId, accountId),
								eq(developerCreditTransactions.referenceId, referenceId),
							),
						)
						.limit(1);
					return String(
						(row?.metadata as { shortSince?: string | null } | undefined)
							?.shortSince,
					);
				};

				for (let step = 0; step < steps; step++) {
					const kind = pick(kinds);
					let available = balance - held;
					log.push(`${kind} balance=${balance} held=${held}`);
					let stepKind: (typeof kinds)[number] = kind;
					if (kind === "daily_part_in_month") {
						if (dayIndex < 0) continue;
						if (!period || period.monthMax === 0) {
							if (available <= 0) continue;
							const holdId = id();
							await database().insert(developerTranscripts).values({
								id: holdId,
								appId,
								status: "processing",
								sourceType: "upload",
								reservedMicroCredits: available,
							});
							held += available;
							const minutes = between(1, 240);
							const owed = minutes * 85;
							latch();
							const videoId = await makeVideo(appId, {
								duration: minutes * 60,
							});
							await settleFirstMonthAtReady({ id: videoId, deletedAt: null });
							log[log.length - 1] += ` month owed=${owed}`;
							period = period
								? {
										since: period.since,
										monthMax: Math.max(period.monthMax, owed),
									}
								: { since: await rowSince(videoId), monthMax: owed };
							await database()
								.update(developerTranscripts)
								.set({ status: "complete", reservedMicroCredits: 0 })
								.where(eq(developerTranscripts.id, holdId));
							held -= available;
						}
						available = balance - held;
						if (available <= 0) continue;
						stepKind = "daily_short";
					}
					if (kind === "top_up_then_short_same_second") {
						if (dayIndex < 0) continue;
						const toppedUpAt = await topUp();
						available = balance - held;
						if (available > 0) {
							const holdId = id();
							await database().insert(developerTranscripts).values({
								id: holdId,
								appId,
								status: "processing",
								sourceType: "upload",
								reservedMicroCredits: available,
							});
							holds.push({ id: holdId, amount: available });
							held += available;
							log[log.length - 1] += ` hold ${available}`;
						}
						available = balance - held;
						stepKind = "daily_short";
						const dateKey = new Date(Date.now() - dayIndex * DAY_MS)
							.toISOString()
							.slice(0, 10);
						const owed = available + between(1, 20_000);
						latch();
						const result = await chargeStorageDay({
							appId,
							accountId,
							usage: {
								videoCount: 1,
								totalMinutes: 1,
								minutesByTier: emptyStorageMinutes(),
								monthlyMicroCredits: owed * 30,
								dailyMicroCredits: owed,
							},
							dateKey,
							now: new Date(),
						});
						dayIndex--;
						log[log.length - 1] +=
							` owed=${owed} -> ${result.state} same second`;
						if (result.state === "billed") {
							await database()
								.update(developerCreditTransactions)
								.set({ createdAt: toppedUpAt ?? new Date() })
								.where(
									and(
										eq(developerCreditTransactions.accountId, accountId),
										eq(developerCreditTransactions.referenceId, dateKey),
									),
								);
							const charged = Math.min(balance - held, owed);
							balance -= charged;
							const since: string =
								(period as Period | null)?.since ?? (await rowSince(dateKey));
							lastDaily = { since, owed };
							period = period ?? { since, monthMax: 0 };
						}
					} else if (
						stepKind === "delivery_paid" ||
						stepKind === "delivery_short"
					) {
						const target =
							stepKind === "delivery_paid"
								? between(0, Math.max(0, available))
								: Math.max(0, available) + between(1, 20_000);
						const seconds =
							stepKind === "delivery_paid"
								? Math.floor((target * 60) / 95)
								: Math.ceil((target * 60) / 95);
						const owed = deliveryMicroCredits(seconds);
						const dateKey = new Date(Date.now() - deliveryIndex * DAY_MS)
							.toISOString()
							.slice(0, 10);
						latch();
						const result = await chargeDeliveryDay({
							appId,
							accountId,
							delivered: {
								day: dateKey,
								seconds,
								secondsByTier: { "1080p": seconds },
							},
							now: new Date(),
						});
						deliveryIndex--;
						await database()
							.update(developerCreditTransactions)
							.set({
								createdAt: sql`${developerCreditTransactions.createdAt} - INTERVAL 1 SECOND`,
							})
							.where(eq(developerCreditTransactions.accountId, accountId));
						log[log.length - 1] += ` delivery owed=${owed} -> ${result.state}`;
						if (result.state !== "billed") continue;
						delivered.billed++;
						const charged = Math.max(0, Math.min(balance - held, owed));
						balance -= charged;
						if (charged < owed) {
							delivered.short++;
							if (period) delivered.carried++;
							if (!(period && charged === 0)) {
								const since: string =
									(period as Period | null)?.since ?? (await rowSince(dateKey));
								lastDaily = { since, owed };
								period = period ?? { since, monthMax: 0 };
							}
						} else {
							lastDaily = { since: null, owed: 0 };
							if (period?.monthMax === 0) period = null;
						}
					} else if (stepKind === "daily_paid" || stepKind === "daily_short") {
						if (dayIndex < 0) continue;
						const owed =
							stepKind === "daily_paid"
								? between(0, available)
								: available + between(1, 20_000);
						const dateKey = new Date(Date.now() - dayIndex * DAY_MS)
							.toISOString()
							.slice(0, 10);
						latch();
						const result = await chargeStorageDay({
							appId,
							accountId,
							usage: {
								videoCount: 1,
								totalMinutes: 1,
								minutesByTier: emptyStorageMinutes(),
								monthlyMicroCredits: owed * 30,
								dailyMicroCredits: owed,
							},
							dateKey,
							now: new Date(),
						});
						dayIndex--;
						log[log.length - 1] += ` owed=${owed} -> ${result.state}`;
						if (result.state !== "billed") continue;
						const charged = Math.min(balance - held, owed);
						balance -= charged;
						if (charged < owed) {
							const since: string =
								(period as Period | null)?.since ?? (await rowSince(dateKey));
							lastDaily = { since, owed };
							period = period ?? { since, monthMax: 0 };
						} else {
							lastDaily = { since: null, owed: 0 };
							if (period?.monthMax === 0) period = null;
						}
					} else if (
						kind === "month_paid" ||
						kind === "month_short" ||
						kind === "month_short_pair"
					) {
						const minutes = Math.min(
							240,
							kind === "month_paid"
								? Math.floor(available / 85)
								: Math.floor(available / 85) + between(1, 200),
						);
						if (kind !== "month_paid" && minutes * 85 <= available) continue;
						if (minutes < 1) continue;
						if (kind === "month_short_pair" && minutes >= 240) continue;
						const sizes =
							kind === "month_short_pair"
								? [minutes, between(minutes + 1, 240)]
								: [minutes];
						const videoIds: string[] = [];
						for (const size of sizes) {
							const owed = size * 85;
							latch();
							const videoId = await makeVideo(appId, { duration: size * 60 });
							await settleFirstMonthAtReady({ id: videoId, deletedAt: null });
							videoIds.push(videoId);
							log[log.length - 1] += ` owed=${owed}`;
							const charged = Math.min(balance - held, owed);
							balance -= charged;
							if (charged < owed) {
								period = period
									? {
											since: period.since,
											monthMax: Math.max(period.monthMax, owed),
										}
									: { since: await rowSince(videoId), monthMax: owed };
							}
						}
						if (videoIds.length > 1) {
							const [first] = await database()
								.select({ createdAt: developerCreditTransactions.createdAt })
								.from(developerCreditTransactions)
								.where(
									and(
										eq(developerCreditTransactions.accountId, accountId),
										eq(
											developerCreditTransactions.referenceId,
											videoIds[0] ?? "",
										),
									),
								);
							await database()
								.update(developerCreditTransactions)
								.set({ createdAt: first?.createdAt ?? new Date() })
								.where(
									and(
										eq(developerCreditTransactions.accountId, accountId),
										inArray(developerCreditTransactions.referenceId, videoIds),
									),
								);
						}
					} else if (kind === "hold") {
						if (available <= 0) continue;
						const amount = between(1, available);
						const holdId = id();
						await database().insert(developerTranscripts).values({
							id: holdId,
							appId,
							status: "processing",
							sourceType: "upload",
							reservedMicroCredits: amount,
						});
						holds.push({ id: holdId, amount });
						held += amount;
						log[log.length - 1] += ` +${amount}`;
					} else if (kind === "release") {
						const hold = holds.shift();
						if (!hold) continue;
						await database()
							.update(developerTranscripts)
							.set({ status: "complete", reservedMicroCredits: 0 })
							.where(eq(developerTranscripts.id, hold.id));
						held -= hold.amount;
						log[log.length - 1] += ` -${hold.amount}`;
					} else {
						await topUp();
					}

					const where = `sequence ${sequence} step ${step}: ${log.join(" | ")}`;
					if ((await balanceOf(accountId)) !== balance) {
						failures.push(
							`${where}: balance ${await balanceOf(accountId)} expected ${balance}`,
						);
						break;
					}
					const short = period !== null && balance - held < size();
					const { standing } = await getInfraBilling(appId);
					const expected = short
						? {
								state: "grace",
								pausesAt: new Date(
									Date.parse(period?.since ?? "") + 7 * DAY_MS,
								),
							}
						: { state: "active", pausesAt: null };
					if (JSON.stringify(standing) !== JSON.stringify(expected)) {
						failures.push(
							`${where}: standing ${JSON.stringify(standing)} expected ${JSON.stringify(expected)} period ${JSON.stringify(period)} size ${size()} lastDaily ${JSON.stringify(lastDaily)}`,
						);
						break;
					}
					if (latched.size > 0) {
						const rows = await database()
							.select({ metadata: developerCreditTransactions.metadata })
							.from(developerCreditTransactions)
							.where(eq(developerCreditTransactions.accountId, accountId));
						const unresolved = rows.filter((row) => {
							const fields = row.metadata as {
								shortSince?: string | null;
								resolvedAt?: string;
							} | null;
							return (
								fields?.shortSince &&
								latched.has(fields.shortSince) &&
								!fields.resolvedAt
							);
						});
						if (unresolved.length > 0) {
							failures.push(
								`${where}: ${unresolved.length} rows of a covered shortfall unresolved`,
							);
							break;
						}
					}
				}
			}

			expect(failures).toEqual([]);
			expect(delivered.billed).toBeGreaterThan(250);
			expect(delivered.short).toBeGreaterThan(150);
			expect(delivered.carried).toBeGreaterThan(50);
			console.info("[seeded] delivery steps", delivered);
		}, 600_000);

		const chargeDay = (
			appId: string,
			accountId: string,
			dailyMicroCredits: number,
			daysAgo: number,
		) =>
			chargeStorageDay({
				appId,
				accountId,
				usage: {
					videoCount: 1,
					totalMinutes: 1,
					minutesByTier: emptyStorageMinutes(),
					monthlyMicroCredits: dailyMicroCredits * 30,
					dailyMicroCredits,
				},
				dateKey: new Date(Date.now() - daysAgo * DAY_MS)
					.toISOString()
					.slice(0, 10),
				now: new Date(),
			});

		const setBalance = (accountId: string, balanceMicroCredits: number) =>
			database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits })
				.where(eq(developerCreditAccounts.id, accountId));

		it("forgives an older unpaid day once the latest day is covered, then a first month latches the whole period", async () => {
			const { appId, accountId } = await makeApp(0);
			expect(await chargeDay(appId, accountId, 5_000, 3)).toMatchObject({
				state: "billed",
				chargedMicroCredits: 0,
			});
			await setBalance(accountId, 450);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 400,
			});
			expect(await chargeDay(appId, accountId, 300, 2)).toMatchObject({
				state: "billed",
				chargedMicroCredits: 50,
				owedMicroCredits: 300,
			});
			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			expect(await balanceOf(accountId)).toBe(400);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});

			await settleFirstMonthAtReady({
				id: await makeVideo(appId, { duration: 106 }),
				deletedAt: null,
			});
			expect(await balanceOf(accountId)).toBe(250);
			const days = await database()
				.select({ metadata: developerCreditTransactions.metadata })
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.type, "storage_daily"),
					),
				);
			expect(days).toHaveLength(2);
			for (const day of days) {
				expect((day.metadata as { resolvedAt?: string }).resolvedAt).toEqual(
					expect.any(String),
				);
			}
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("sizes a run of short days by the latest day, as before first months", async () => {
			const { appId, accountId } = await makeApp(0);
			await chargeDay(appId, accountId, 1_000, 4);
			const [first] = await database()
				.select({ metadata: developerCreditTransactions.metadata })
				.from(developerCreditTransactions)
				.where(eq(developerCreditTransactions.accountId, accountId));
			const shortSince = (first?.metadata as { shortSince: string }).shortSince;
			const grace = {
				state: "grace",
				pausesAt: new Date(Date.parse(shortSince) + 7 * DAY_MS),
			};

			await setBalance(accountId, 10);
			expect(await chargeDay(appId, accountId, 28, 3)).toMatchObject({
				state: "billed",
				chargedMicroCredits: 10,
				shortSince: new Date(shortSince),
			});
			await setBalance(accountId, 20);
			expect((await getInfraBilling(appId)).standing).toEqual(grace);
			await setBalance(accountId, 100);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});

			await setBalance(accountId, 100);
			const third = await chargeDay(appId, accountId, 2_000, 2);
			expect(third).toMatchObject({
				state: "billed",
				chargedMicroCredits: 100,
			});
			const thirdSince =
				third.state === "billed" ? (third.shortSince ?? null) : null;
			expect(thirdSince?.getTime()).toBeGreaterThan(Date.parse(shortSince));
			await setBalance(accountId, 1_500);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "grace",
				pausesAt: new Date((thirdSince?.getTime() ?? 0) + 7 * DAY_MS),
			});
			await setBalance(accountId, 500);
			expect(await chargeDay(appId, accountId, 400, 1)).toMatchObject({
				state: "billed",
				chargedMicroCredits: 400,
				shortSince: null,
			});
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("sizes a first month grace period by a larger daily charge it carries", async () => {
			const { appId, accountId } = await makeApp(900);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 900,
			});
			await settleFirstMonthAtReady({
				id: await makeVideo(appId),
				deletedAt: null,
			});
			const [month] = await firstMonthRows(accountId);
			const shortSince = (month?.metadata as { shortSince: string }).shortSince;
			expect(month).toMatchObject({ amountMicroCredits: 0 });
			expect(month?.metadata).toMatchObject({ owedMicroCredits: 850 });

			await database()
				.update(developerTranscripts)
				.set({ reservedMicroCredits: 400 })
				.where(eq(developerTranscripts.id, transcriptId));
			expect(
				await chargeStorageDay({
					appId,
					accountId,
					usage: {
						videoCount: 1,
						totalMinutes: 1,
						minutesByTier: emptyStorageMinutes(),
						monthlyMicroCredits: 1_120 * 30,
						dailyMicroCredits: 1_120,
					},
					dateKey: new Date().toISOString().slice(0, 10),
					now: new Date(),
				}),
			).toMatchObject({
				state: "billed",
				chargedMicroCredits: 500,
				owedMicroCredits: 1_120,
			});

			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 900 })
				.where(eq(developerCreditAccounts.id, accountId));
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "grace",
				pausesAt: new Date(Date.parse(shortSince) + 7 * DAY_MS),
			});

			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 1_120 })
				.where(eq(developerCreditAccounts.id, accountId));
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("reads the largest unpaid month of a shortfall when two fall short in the same second", async () => {
			const { appId, accountId } = await makeApp(900);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 900,
			});
			const smallVideo = await makeVideo(appId);
			await settleFirstMonthAtReady({ id: smallVideo, deletedAt: null });
			const largeVideo = await makeVideo(appId, {
				duration: 3_600,
				width: 3840,
				height: 2160,
				maxResolutionTier: "2160p",
			});
			await settleFirstMonthAtReady({ id: largeVideo, deletedAt: null });
			const rows = await firstMonthRows(accountId);
			const small = rows.find((row) => row.referenceId === smallVideo);
			const large = rows.find((row) => row.referenceId === largeVideo);
			const shortSince = (small?.metadata as { shortSince: string }).shortSince;
			expect(small?.metadata).toMatchObject({ owedMicroCredits: 850 });
			expect(large?.metadata).toMatchObject({
				owedMicroCredits: 16_800,
				outstandingMicroCredits: 16_800,
				shortSince,
			});
			const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 5_000);
			const smallId = `0${id().slice(1)}`;
			const largeId = `z${id().slice(1)}`;
			for (const [from, to] of [
				[small?.id ?? "", smallId],
				[large?.id ?? "", largeId],
			] as const) {
				await database()
					.update(developerCreditTransactions)
					.set({ id: to, createdAt: second })
					.where(eq(developerCreditTransactions.id, from));
			}

			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			const pausesAt = new Date(Date.parse(shortSince) + 7 * DAY_MS);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "grace",
				pausesAt,
			});

			await settleFirstMonthAtReady({
				id: await makeVideo(appId, { duration: 60 }),
				deletedAt: null,
			});
			expect(await balanceOf(accountId)).toBe(815);
			const after = new Map(
				(await firstMonthRows(accountId)).map((row) => [
					row.id,
					(row.metadata as { resolvedAt?: string }).resolvedAt,
				]),
			);
			expect(after.get(smallId)).toBeUndefined();
			expect(after.get(largeId)).toBeUndefined();
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "grace",
				pausesAt,
			});

			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 17_000 })
				.where(eq(developerCreditAccounts.id, accountId));
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, { duration: 60 }),
				deletedAt: null,
			});
			const covered = new Map(
				(await firstMonthRows(accountId)).map((row) => [
					row.id,
					(row.metadata as { resolvedAt?: string }).resolvedAt,
				]),
			);
			expect(covered.get(smallId)).toEqual(expect.any(String));
			expect(covered.get(largeId)).toBe(covered.get(smallId));
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		it("resolves every copy of a covered first month shortfall together, and no other shortfall", async () => {
			const { appId, accountId } = await makeApp(900);
			const transcriptId = id();
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "processing",
				sourceType: "upload",
				reservedMicroCredits: 900,
			});
			const fourK = {
				duration: 3_600,
				width: 3840,
				height: 2160,
				maxResolutionTier: "2160p" as const,
			};
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, fourK),
				deletedAt: null,
			});
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, fourK),
				deletedAt: null,
			});
			const copies = await firstMonthRows(accountId);
			expect(copies).toHaveLength(2);
			const shortSince = (copies[0]?.metadata as { shortSince: string })
				.shortSince;
			for (const copy of copies) {
				expect(copy.amountMicroCredits).toBe(0);
				expect(copy.metadata).toMatchObject({
					owedMicroCredits: 16_800,
					shortSince,
				});
			}
			const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 5_000);
			await database()
				.update(developerCreditTransactions)
				.set({ createdAt: second })
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.type, "video_create"),
					),
				);
			const otherShortSince = new Date(
				Date.parse(shortSince) + 60_000,
			).toISOString();
			const otherId = id();
			await database()
				.insert(developerCreditTransactions)
				.values({
					id: otherId,
					accountId,
					type: "video_create",
					amountMicroCredits: 0,
					balanceAfterMicroCredits: 0,
					referenceId: id(),
					referenceType: "developer_video",
					metadata: {
						owedMicroCredits: 850,
						chargedMicroCredits: 0,
						shortSince: otherShortSince,
						fellShort: true,
					},
					createdAt: new Date(second.getTime() - 60_000),
				});
			expect((await getInfraBilling(appId)).standing.state).toBe("grace");

			await makeVideo(appId, { createdAt: new Date("2026-10-01T00:00:00Z") });
			await database()
				.update(developerTranscripts)
				.set({ status: "complete", reservedMicroCredits: 0 })
				.where(eq(developerTranscripts.id, transcriptId));
			await database()
				.update(developerCreditAccounts)
				.set({ balanceMicroCredits: 16_800 })
				.where(eq(developerCreditAccounts.id, accountId));
			const today = new Date().toISOString().slice(0, 10);
			const usage = (
				await getStorageUsageByApp([appId], undefined, undefined, {
					dailyChargeAt: new Date(`${today}T00:00:00.000Z`),
				})
			).get(appId);
			if (!usage) throw new Error("no usage");
			expect(
				await chargeStorageDay({
					appId,
					accountId,
					usage,
					dateKey: today,
					now: new Date(),
				}),
			).toMatchObject({ state: "billed", chargedMicroCredits: 28 });
			expect(await balanceOf(accountId)).toBe(16_772);

			const resolved = new Map(
				(await firstMonthRows(accountId)).map((row) => [
					row.id,
					(row.metadata as { resolvedAt?: string }).resolvedAt,
				]),
			);
			for (const copy of copies) {
				expect(resolved.get(copy.id)).toEqual(expect.any(String));
			}
			expect(resolved.get(copies[0]?.id ?? "")).toBe(
				resolved.get(copies[1]?.id ?? ""),
			);
			expect(resolved.get(otherId)).toBeUndefined();
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});

			const nextVideo = await makeVideo(appId);
			await settleFirstMonthAtReady({ id: nextVideo, deletedAt: null });
			const next = (await firstMonthRows(accountId)).find(
				(row) => row.referenceId === nextVideo,
			);
			expect(next).toMatchObject({ amountMicroCredits: -850 });
			expect(next?.metadata).toMatchObject({ shortSince: null });
			expect(await balanceOf(accountId)).toBe(15_922);
			expect((await getInfraBilling(appId)).standing).toEqual({
				state: "active",
				pausesAt: null,
			});
		});

		describe("a video deleted while it encodes", () => {
			const encoding = (): DeveloperVideoProcessingState => ({
				...processing(),
				probe: null,
				mp4: {
					state: "running",
					token: "t-mp4",
					jobId: "job-1",
					startedAt: Date.now(),
				},
				attempts: { hls: 0, mp4: 1 },
			});
			const deleteNow = (videoId: string) =>
				database()
					.update(developerVideos)
					.set({ deletedAt: new Date() })
					.where(eq(developerVideos.id, videoId));

			it("is charged its first month once, from its declared length at the tier it was created with, and never again", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const videoId = await makeVideo(appId, {
					createdAt: new Date(),
					status: "processing",
					duration: 3600,
					width: null,
					height: null,
					maxResolutionTier: "2160p",
					processing: encoding(),
				});
				await deleteNow(videoId);

				const charged = await settleFirstMonthAtDelete(videoId);
				expect(charged).toMatchObject({
					state: "charged",
					tier: "2160p",
					owedMicroCredits: 16_800,
					chargedMicroCredits: 16_800,
				});
				expect(await settleFirstMonthAtDelete(videoId)).toEqual({
					state: "skipped",
					reason: "already_settled",
				});

				await database()
					.update(developerVideos)
					.set({ status: "ready" })
					.where(eq(developerVideos.id, videoId));
				await settleFirstMonthAtReady({ id: videoId, deletedAt: new Date() });
				await chargeMissedFirstMonths(new Date());

				const rows = await firstMonthRows(accountId);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					amountMicroCredits: -16_800,
					referenceId: videoId,
					referenceType: "developer_video",
				});
				expect(rows[0]?.metadata).toMatchObject({ deletedWhileEncoding: true });
				expect(await balanceOf(accountId)).toBe(1_000_000 - 16_800);
				expect((await videoRow(videoId))?.storagePaidUntil).not.toBeNull();
			});

			it("is charged when deleted while a failed attempt waits for its retry", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const videoId = await makeVideo(appId, {
					createdAt: new Date(),
					status: "processing",
					duration: 600,
					processing: {
						...processing(),
						probe: null,
						mp4: { state: "pending" },
						hls: { state: "pending" },
						attempts: { hls: 0, mp4: 1 },
					},
				});
				await deleteNow(videoId);

				expect(await settleFirstMonthAtDelete(videoId)).toMatchObject({
					state: "charged",
					owedMicroCredits: 850,
				});
				expect(await firstMonthRows(accountId)).toHaveLength(1);
			});

			it("is charged once when deleted after a dispatched attempt failed and was reset, even if the retry then found the farm busy", async () => {
				const started = createDeveloperVideoProcessingState({
					encodeId: "encode-1",
					now: Date.now(),
				});
				const running = beginPart(started, "mp4", {
					token: "t-1",
					now: Date.now(),
				});
				const dispatched =
					running &&
					markPartDispatched(running, "mp4", { token: "t-1", jobId: "job-1" });
				const failed =
					dispatched &&
					settlePart(dispatched, "mp4", "t-1", {
						type: "failed",
						reason: "encoder stopped",
					});
				const retried =
					failed && beginPart(failed, "mp4", { token: "t-2", now: Date.now() });
				const busy = retried && releasePart(retried, "mp4", "t-2");
				if (!failed || !busy) throw new Error("state did not advance");
				expect(failed.mp4).toEqual({ state: "pending" });
				expect(busy.mp4).toEqual({ state: "pending" });

				for (const state of [failed, busy]) {
					const { appId, accountId } = await makeApp(1_000_000);
					const videoId = await makeVideo(appId, {
						createdAt: new Date(),
						status: "processing",
						duration: 600,
						processing: state,
					});
					await deleteNow(videoId);

					expect(await settleFirstMonthAtDelete(videoId)).toMatchObject({
						state: "charged",
						owedMicroCredits: 850,
					});
					expect(await settleFirstMonthAtDelete(videoId)).toEqual({
						state: "skipped",
						reason: "already_settled",
					});
					expect(await firstMonthRows(accountId)).toHaveLength(1);
				}
			});

			it("caps the declared length at the 4 hour limit", async () => {
				const { appId } = await makeApp(1_000_000);
				const videoId = await makeVideo(appId, {
					createdAt: new Date(),
					status: "processing",
					duration: 6 * 60 * 60,
					processing: encoding(),
				});
				await deleteNow(videoId);

				expect(await settleFirstMonthAtDelete(videoId)).toMatchObject({
					state: "charged",
					owedMicroCredits: 240 * 85,
				});
			});

			it("pays nothing when deleted before any encode was handed to the farm, including a slot reserved but not yet sent", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const notClaimed = await makeVideo(appId, {
					status: "uploading",
					processing: null,
					playbackId: null,
				});
				const claimedNotSent = await makeVideo(appId, {
					createdAt: new Date(),
					status: "processing",
					processing: {
						...processing(),
						mp4: { state: "pending" },
						attempts: { hls: 0, mp4: 0 },
					},
				});
				const reservedNotSent = await makeVideo(appId, {
					createdAt: new Date(),
					status: "processing",
					processing: {
						...processing(),
						mp4: {
							state: "running",
							token: "t-mp4",
							jobId: null,
							startedAt: Date.now(),
						},
						attempts: { hls: 0, mp4: 1 },
					},
				});
				for (const videoId of [notClaimed, claimedNotSent, reservedNotSent]) {
					await deleteNow(videoId);
					expect(await settleFirstMonthAtDelete(videoId)).toEqual({
						state: "skipped",
						reason: "not_dispatched",
					});
					expect((await videoRow(videoId))?.storagePaidUntil).toBeNull();
				}
				expect(await firstMonthRows(accountId)).toHaveLength(0);
				expect(await balanceOf(accountId)).toBe(1_000_000);
			});

			it("pays nothing for an encode that failed on its own, deleted or not", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const failed = await makeVideo(appId, {
					status: "errored",
					processing: {
						...processing(),
						mp4: { state: "failed", reason: "boom" },
						hls: { state: "failed", reason: "boom" },
						attempts: { hls: 2, mp4: 2 },
					},
				});
				await deleteNow(failed);

				expect(await settleFirstMonthAtDelete(failed)).toEqual({
					state: "skipped",
					reason: "not_dispatched",
				});
				expect(await firstMonthRows(accountId)).toHaveLength(0);
			});

			it("is charged when the whole app is deleted mid-encode, and leaves videos deleted long before alone", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const [owner] = await database()
					.select({ ownerId: developerApps.ownerId })
					.from(developerApps)
					.where(eq(developerApps.id, appId));
				vi.mocked(getCurrentUser).mockResolvedValue({
					id: owner?.ownerId,
					email: "owner@example.com",
				} as never);
				const encodingNow = await makeVideo(appId, {
					createdAt: new Date(),
					status: "processing",
					duration: 600,
					processing: encoding(),
				});
				const deletedLongAgo = await makeVideo(appId, {
					createdAt: new Date("2026-10-01T00:00:00Z"),
					deletedAt: new Date("2026-10-02T00:00:00Z"),
					status: "processing",
					duration: 600,
					processing: encoding(),
				});
				const readyLongAgo = await makeVideo(appId, {
					createdAt: new Date("2026-10-01T00:00:00Z"),
					deletedAt: new Date("2026-10-02T00:00:00Z"),
				});

				await deleteDeveloperApp(appId);
				await settleFirstMonthAtDelete(encodingNow);

				const rows = await firstMonthRows(accountId);
				expect(rows.map((row) => row.referenceId)).toEqual([encodingNow]);
				expect(await balanceOf(accountId)).toBe(1_000_000 - 850);
				for (const videoId of [deletedLongAgo, readyLongAgo]) {
					expect((await videoRow(videoId))?.storagePaidUntil).toBeNull();
				}
			});

			it("charges nothing for a pre-feature ready video and marks it exempt", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const videoId = await makeVideo(appId, {
					createdAt: new Date("2026-10-01T00:00:00Z"),
				});
				await deleteNow(videoId);

				expect(await settleFirstMonthAtDelete(videoId)).toMatchObject({
					state: "exempt",
				});
				expect((await videoRow(videoId))?.storagePaidUntil).not.toBeNull();
				expect(await firstMonthRows(accountId)).toHaveLength(0);
				expect(await balanceOf(accountId)).toBe(1_000_000);
			});

			it("charges nothing for a video mid-encode created before first month charging began", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const videoId = await makeVideo(appId, {
					createdAt: new Date("2026-10-01T00:00:00Z"),
					status: "processing",
					duration: 600,
					processing: encoding(),
				});
				await deleteNow(videoId);

				expect(await settleFirstMonthAtDelete(videoId)).toMatchObject({
					state: "exempt",
				});
				expect(await firstMonthRows(accountId)).toHaveLength(0);
			});

			it("charges nothing more for a post-feature ready video that already paid its month", async () => {
				const { appId, accountId } = await makeApp(1_000_000);
				const videoId = await makeVideo(appId, { createdAt: new Date() });
				await settleFirstMonthAtReady({ id: videoId, deletedAt: null });
				await deleteNow(videoId);

				expect(await settleFirstMonthAtDelete(videoId)).toEqual({
					state: "skipped",
					reason: "already_settled",
				});
				expect(await firstMonthRows(accountId)).toHaveLength(1);
				expect(await balanceOf(accountId)).toBe(1_000_000 - 850);
			});

			it("records a month the balance cannot pay as owed and leaves the delete in place", async () => {
				const { appId, accountId } = await makeApp(100);
				const videoId = await makeVideo(appId, {
					createdAt: new Date(),
					status: "processing",
					duration: 600,
					processing: encoding(),
				});
				await deleteNow(videoId);

				expect(await settleFirstMonthAtDelete(videoId)).toMatchObject({
					state: "charged",
					owedMicroCredits: 850,
					chargedMicroCredits: 100,
				});
				expect(await balanceOf(accountId)).toBe(0);
				expect((await videoRow(videoId))?.deletedAt).not.toBeNull();
				expect((await getInfraBilling(appId)).standing.state).toBe("grace");
			});
		});

		it("finds a new first month shortfall for its email once, and never one that only carried an earlier shortfall", async () => {
			const { appId, accountId } = await makeApp(0);
			const since = new Date(Date.now() - 60 * 60 * 1000);
			await settleFirstMonthAtReady({
				id: await makeVideo(appId),
				deletedAt: null,
			});

			const found = await shortfallsAwaitingNotice([accountId], since);
			expect([...found.keys()]).toEqual([accountId]);
			const [first] = await firstMonthRows(accountId);
			expect(first?.metadata).toMatchObject({ fellShort: true });

			await settleFirstMonthAtReady({
				id: await makeVideo(appId),
				deletedAt: null,
			});
			const rows = await firstMonthRows(accountId);
			expect(rows).toHaveLength(2);
			expect(
				rows.map((row) => (row.metadata as { fellShort: boolean }).fellShort),
			).toEqual(expect.arrayContaining([true, false]));
			expect(
				(await shortfallsAwaitingNotice([accountId], since)).get(accountId)
					?.ids,
			).toEqual([first?.id]);

			await markShortfallsNotified(found.get(accountId)?.ids ?? [], new Date());
			await markShortfallsNotified(
				found.get(accountId)?.ids ?? [],
				new Date(Date.now() + 60_000),
			);
			expect(await shortfallsAwaitingNotice([accountId], since)).toEqual(
				new Map(),
			);
		});

		it("keeps a daily shortfall whose email was not sent for the next run, and drops it once sent", async () => {
			const { appId, accountId } = await makeApp(0);
			await makeVideo(appId, { createdAt: new Date("2026-10-01T00:00:00Z") });
			const since = new Date(Date.now() - 60 * 60 * 1000);
			const today = new Date().toISOString().slice(0, 10);
			const usage = (
				await getStorageUsageByApp([appId], undefined, undefined, {
					dailyChargeAt: new Date(`${today}T00:00:00.000Z`),
				})
			).get(appId);
			if (!usage) throw new Error("no usage");

			expect(
				await chargeStorageDay({
					appId,
					accountId,
					usage,
					dateKey: today,
					now: new Date(),
				}),
			).toMatchObject({ state: "billed", fellShort: true });

			const waiting = await shortfallsAwaitingNotice([accountId], since);
			expect(waiting.get(accountId)?.ids).toHaveLength(1);

			await markStorageDayNotified(accountId, today, new Date());
			expect(await shortfallsAwaitingNotice([accountId], since)).toEqual(
				new Map(),
			);
		});

		it("never throws from the ready path when the charge fails", async () => {
			const broken = {
				transaction: async () => {
					throw new Error("connection lost");
				},
			} as never;
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(
				settleFirstMonthAtReady({ id: id(), deletedAt: null }, broken),
			).resolves.toBeUndefined();
			expect(errors).toHaveBeenCalled();
			errors.mockRestore();
		});

		it("admits one upload on a balance that covers one first month, and refuses the others completing at the same time", async () => {
			const { appId } = await makeApp(5_600);
			const videos = await Promise.all(
				Array.from({ length: 4 }, () =>
					makeVideo(appId, {
						status: "processing",
						duration: null,
						width: null,
						height: null,
						maxResolutionTier: "2160p",
					}),
				),
			);

			const results = await Promise.all(
				videos.map((videoId) =>
					recordAdmittedInfraUpload(
						{
							appId,
							videoId,
							durationSeconds: 1200,
							width: 3840,
							height: 2160,
							maxResolutionTier: "2160p",
						},
						{ duration: 1200, width: 3840, height: 2160 },
					),
				),
			);

			const admitted = results.filter(
				(result) => "allowed" in result && result.allowed,
			);
			const refused = results.filter(
				(result) => "allowed" in result && !result.allowed,
			);
			expect(admitted).toHaveLength(1);
			expect(refused).toHaveLength(3);
			for (const refusal of refused) {
				expect("message" in refusal && refusal.message).toMatch(
					/^Not enough credit /,
				);
				expect(refusal).toMatchObject({
					reason: "insufficient_credits",
					requiredMicroCredits: 11_200,
					shortfallMicroCredits: 5_600,
				});
			}
			const recorded = await Promise.all(videos.map(videoRow));
			expect(recorded.filter((video) => video?.duration === 1200)).toHaveLength(
				1,
			);
		});

		it("needs the first month of the upload and of every upload in flight", async () => {
			const { appId } = await makeApp(0);
			const upload = {
				durationSeconds: 1200,
				width: 3840,
				height: 2160,
				tier: "2160p" as const,
			};

			expect(
				(await getInfraUploadAdmission(appId, upload)).requiredMicroCredits,
			).toBe(5_600);

			for (let n = 0; n < 2; n++) {
				await makeVideo(appId, {
					status: "processing",
					duration: 1200,
					width: 3840,
					height: 2160,
					maxResolutionTier: "2160p",
				});
			}
			expect(
				(await getInfraUploadAdmission(appId, upload)).requiredMicroCredits,
			).toBe(16_800);

			const clips = (await makeApp(0)).appId;
			for (let n = 0; n < 3; n++) {
				await makeVideo(clips, { status: "processing", duration: 1 });
			}
			await makeVideo(clips, { status: "processing", duration: 0.2 });
			const clip = {
				durationSeconds: 1,
				width: 1920,
				height: 1080,
				tier: "1080p" as const,
			};
			expect((await getAppStorage(clips)).firstMonthMicroCredits).toBe(4);
			expect(
				(await getInfraUploadAdmission(clips, clip)).requiredMicroCredits,
			).toBe(5);
		});

		describe("a ready video whose first month is not charged yet", () => {
			const fourK = {
				status: "ready" as const,
				duration: 1200,
				width: 3840,
				height: 2160,
				maxResolutionTier: "2160p" as const,
				storagePaidUntil: null,
			};
			const upload = {
				durationSeconds: 1200,
				width: 3840,
				height: 2160,
				tier: "2160p" as const,
			};
			let sentinel: string;

			beforeAll(async () => {
				const { appId, accountId } = await makeApp(0);
				sentinel = await makeVideo(appId, {
					storagePaidUntil: new Date("2026-10-31T00:00:00Z"),
				});
				await database()
					.insert(developerCreditTransactions)
					.values({
						id: id(),
						accountId,
						type: "video_create",
						amountMicroCredits: -100,
						balanceAfterMicroCredits: 0,
						referenceId: sentinel,
						referenceType: "developer_video",
						metadata: { paidUntil: "2026-10-31T00:00:00.000Z" },
						createdAt: new Date("2026-10-01T12:00:00Z"),
					});
			});

			afterAll(async () => {
				await database()
					.delete(developerCreditTransactions)
					.where(eq(developerCreditTransactions.referenceId, sentinel));
				await database()
					.delete(developerVideos)
					.where(eq(developerVideos.id, sentinel));
			});

			it("still reserves its month, so a second upload the balance cannot pay for both is refused", async () => {
				const { appId } = await makeApp(7_000);
				await makeVideo(appId, fourK);

				const storage = await getAppStorage(appId);
				expect(storage.firstMonthMicroCredits).toBe(5_600);
				expect(storage.dailyCharge.totalMinutes).toBe(0);
				expect(storage.stored.totalMinutes).toBe(20);
				expect(await getInfraUploadAdmission(appId, upload)).toMatchObject({
					allowed: false,
					reason: "insufficient_credits",
					requiredMicroCredits: 11_200,
				});
			});

			it("stops reserving it once the month is charged", async () => {
				const { appId, accountId } = await makeApp(7_000);
				const videoId = await makeVideo(appId, fourK);
				await settleFirstMonthAtReady({ id: videoId, deletedAt: null });
				expect(await balanceOf(accountId)).toBe(1_400);

				const storage = await getAppStorage(appId);
				expect(storage.firstMonthMicroCredits).toBe(0);
				expect(storage.stored.totalMinutes).toBe(20);
				expect(
					(await getInfraUploadAdmission(appId, upload)).requiredMicroCredits,
				).toBe(5_600);
			});

			it("leaves a video created before first month charging began to the daily charge", async () => {
				const { appId } = await makeApp(7_000);
				await makeVideo(appId, {
					...fourK,
					createdAt: new Date("2026-09-01T00:00:00Z"),
				});

				const storage = await getAppStorage(appId);
				expect(storage.firstMonthMicroCredits).toBe(0);
				expect(storage.dailyCharge.totalMinutes).toBe(20);
				expect(
					(await getInfraUploadAdmission(appId, upload)).requiredMicroCredits,
				).toBe(6_907);
			});
		});

		it("counts first months in the month's storage spending on the console", async () => {
			const { appId, accountId } = await makeApp(1_000_000);
			const monthStart = new Date(Date.now() - 60 * 60 * 1000);
			await settleFirstMonthAtReady({
				id: await makeVideo(appId),
				deletedAt: null,
			});
			await settleFirstMonthAtReady({
				id: await makeVideo(appId, {
					duration: 3600,
					width: 3840,
					height: 2160,
					maxResolutionTier: "2160p",
				}),
				deletedAt: null,
			});
			await billDay(accountId, "2026-11-13");
			await database()
				.update(developerCreditTransactions)
				.set({ amountMicroCredits: -28 })
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.type, "storage_daily"),
					),
				);

			expect(await getInfraStorageChargesSince(accountId, monthStart)).toBe(
				850 + 16_800 + 28,
			);
			expect(
				await getInfraFirstMonthChargesSince(accountId, monthStart),
			).toEqual({ chargedMicroCredits: 850 + 16_800, videos: 2 });
		});

		it("reports what is stored apart from what the daily charge covers", async () => {
			const { appId } = await makeApp(1_000_000);
			await makeVideo(appId, {
				storagePaidUntil: new Date(Date.now() + 10 * DAY_MS),
			});
			await makeVideo(appId, {
				storagePaidUntil: new Date(Date.now() - DAY_MS),
				duration: 1200,
			});
			await makeVideo(appId, { createdAt: new Date("2026-10-01T00:00:00Z") });
			await makeVideo(appId, { status: "processing", duration: 300 });
			await makeVideo(appId, { status: "uploading", duration: null });
			await makeVideo(appId, { status: "errored" });

			const storage = await getAppStorage(appId);

			expect(storage.stored).toMatchObject({
				videoCount: 3,
				totalMinutes: 40,
				dailyMicroCredits: Math.floor((40 * 85) / 30),
			});
			expect(storage.dailyCharge).toMatchObject({
				videoCount: 2,
				totalMinutes: 30,
				monthlyMicroCredits: 30 * 85,
				dailyMicroCredits: Math.floor((30 * 85) / 30),
			});
			expect(storage.firstMonthMicroCredits).toBe(5 * 85);
			expect(storage.uploadingVideos).toBe(1);

			const billing = await getInfraBilling(appId);
			expect(billing.stored).toEqual(storage.stored);
			expect(billing.admission.requiredMicroCredits).toBe(
				Math.ceil(5 * 85 + (30 * 85 * 7) / 30),
			);
		});

		describe("a top-up and a short storage charge", () => {
			const SECOND = new Date("2026-11-13T09:00:00.000Z");
			const LATER = new Date("2026-11-13T09:00:01.000Z");
			type LedgerInsert = typeof developerCreditTransactions.$inferInsert;
			const row = (
				accountId: string,
				type: LedgerInsert["type"],
				amountMicroCredits: number,
				balanceAfterMicroCredits: number,
				metadata: Record<string, unknown>,
				createdAt = SECOND,
			): LedgerInsert & { id: string } => ({
				id: id(),
				accountId,
				type,
				amountMicroCredits,
				balanceAfterMicroCredits,
				referenceId: id(),
				referenceType:
					type === "topup" ? ("stripe_payment_intent" as const) : null,
				metadata,
				createdAt,
			});
			const shortCharge = (accountId: string, balanceAfter: number) =>
				row(accountId, "storage_daily", 0, balanceAfter, {
					owedMicroCredits: 50,
					shortSince: SECOND.toISOString(),
				});
			const restored = (accountId: string, chargeId: string) =>
				restoredSinceCharge(database() as never, accountId, {
					id: chargeId,
					createdAt: SECOND,
					owedMicroCredits: 50,
					shortSince: SECOND,
				});

			it("never counts a top-up written in the same second as the charge, before or after it", async () => {
				const before = await makeApp(0);
				const earlier = row(before.accountId, "topup", 100, 100, {
					availableAfterMicroCredits: 100,
				});
				const chargeAfterTopUp = shortCharge(before.accountId, 100);
				const spend = row(before.accountId, "transcription", -100, 0, {});
				const after = await makeApp(0);
				const chargeFirst = shortCharge(after.accountId, 0);
				const sameSecond = row(after.accountId, "topup", 100, 100, {
					availableAfterMicroCredits: 100,
				});
				await database()
					.insert(developerCreditTransactions)
					.values([earlier, chargeAfterTopUp, spend, chargeFirst, sameSecond]);

				expect(await restored(before.accountId, chargeAfterTopUp.id)).toBe(
					false,
				);
				expect(await restored(after.accountId, chargeFirst.id)).toBe(false);
			});

			it("counts a top-up in a later second that leaves enough available", async () => {
				const { accountId } = await makeApp(0);
				const charge = shortCharge(accountId, 0);
				const topUp = row(
					accountId,
					"topup",
					100,
					100,
					{ availableAfterMicroCredits: 100 },
					LATER,
				);
				await database()
					.insert(developerCreditTransactions)
					.values([charge, topUp]);

				expect(await restored(accountId, charge.id)).toBe(true);
			});

			it("does not count a later top-up whose credit is held by transcripts", async () => {
				const { accountId } = await makeApp(0);
				const charge = shortCharge(accountId, 0);
				const topUp = row(
					accountId,
					"topup",
					100,
					100,
					{ availableAfterMicroCredits: 40 },
					LATER,
				);
				await database()
					.insert(developerCreditTransactions)
					.values([charge, topUp]);

				expect(await restored(accountId, charge.id)).toBe(false);
			});

			it("compares an older top-up without a recorded available amount on its balance", async () => {
				const { accountId } = await makeApp(0);
				const charge = shortCharge(accountId, 0);
				const topUp = row(accountId, "topup", 100, 100, {}, LATER);
				await database()
					.insert(developerCreditTransactions)
					.values([charge, topUp]);

				expect(await restored(accountId, charge.id)).toBe(true);
			});
		});

		describe("when first month charging began", () => {
			const FIRST_CHARGE = new Date("2020-01-10T10:39:54.000Z");
			const before = new Date(FIRST_CHARGE.getTime() - 1000);
			const after = new Date(FIRST_CHARGE.getTime() + 1000);
			const created: string[] = [];

			const track = async (
				appId: string,
				overrides: Partial<typeof developerVideos.$inferInsert>,
			) => {
				const videoId = await makeVideo(appId, overrides);
				created.push(videoId);
				return videoId;
			};

			const charged = async (
				paidUntil: Date | null,
				chargedAt: Date,
				{ uploadFee = false }: { uploadFee?: boolean } = {},
			) => {
				const { appId, accountId } = await makeApp(0);
				const videoId = await track(appId, {
					createdAt: new Date(chargedAt.getTime() - 60_000),
					storagePaidUntil: paidUntil,
				});
				await database()
					.insert(developerCreditTransactions)
					.values({
						id: id(),
						accountId,
						type: "video_create",
						amountMicroCredits: -850,
						balanceAfterMicroCredits: 0,
						referenceId: videoId,
						referenceType: "developer_video",
						metadata:
							uploadFee || !paidUntil
								? { durationSeconds: 600 }
								: { paidUntil: paidUntil.toISOString() },
						createdAt: chargedAt,
					});
				return videoId;
			};

			const encoding = (): DeveloperVideoProcessingState => ({
				...processing(),
				probe: null,
				mp4: {
					state: "running",
					token: "t-mp4",
					jobId: "job-1",
					startedAt: Date.now(),
				},
				attempts: { hls: 0, mp4: 1 },
			});

			afterEach(async () => {
				if (created.length === 0) return;
				await database()
					.delete(developerCreditTransactions)
					.where(inArray(developerCreditTransactions.referenceId, created));
				await database()
					.delete(developerVideos)
					.where(inArray(developerVideos.id, created));
				created.length = 0;
			});

			it("starts at the exact time of the first real charge, not at a day boundary", async () => {
				await charged(new Date("2020-02-09T00:00:00Z"), FIRST_CHARGE);
				await charged(
					new Date("2020-02-09T00:00:00Z"),
					new Date("2020-01-10T15:00:00Z"),
				);
				await charged(
					new Date("2020-02-10T00:00:00Z"),
					new Date("2020-01-11T09:00:00Z"),
				);

				expect(await firstMonthChargesBegan()).toEqual(FIRST_CHARGE);
			});

			it("starts at the same moment when the first charge came after that day was billed", async () => {
				await charged(new Date("2020-02-10T00:00:00Z"), FIRST_CHARGE);
				await charged(
					new Date("2020-02-09T00:00:00Z"),
					new Date("2020-01-10T12:00:00Z"),
				);
				await charged(
					new Date("2020-02-10T00:00:00Z"),
					new Date("2020-01-11T03:00:00Z"),
				);

				expect(await firstMonthChargesBegan()).toEqual(FIRST_CHARGE);
			});

			it("is not moved by older charge rows of unsettled videos, upload fee rows of settled videos, or videos settled without a charge", async () => {
				await charged(new Date("2020-02-09T00:00:00Z"), FIRST_CHARGE);
				await charged(null, new Date("2019-12-01T04:23:00Z"));
				await charged(
					new Date("2020-02-09T00:00:00Z"),
					new Date("2019-12-01T04:58:00Z"),
					{ uploadFee: true },
				);
				const { appId } = await makeApp(0);
				await track(appId, {
					createdAt: new Date("2019-12-01T00:00:00Z"),
					storagePaidUntil: new Date("2019-12-31T00:00:00Z"),
				});

				expect(await firstMonthChargesBegan()).toEqual(FIRST_CHARGE);
			});

			it("never charges a video created a second before the first charge, and charges one created at or after it exactly once", async () => {
				await charged(new Date("2020-02-09T00:00:00Z"), FIRST_CHARGE);
				const appBefore = await makeApp(1_000_000);
				const videoBefore = await track(appBefore.appId, {
					createdAt: before,
				});
				const appAt = await makeApp(1_000_000);
				const videoAt = await track(appAt.appId, { createdAt: FIRST_CHARGE });

				expect(
					(await getAppStorage(appBefore.appId)).firstMonthMicroCredits,
				).toBe(0);
				expect((await getAppStorage(appAt.appId)).firstMonthMicroCredits).toBe(
					850,
				);

				await chargeMissedFirstMonths(new Date(), 1);
				await chargeMissedFirstMonths(new Date(), 1);

				expect(await firstMonthRows(appBefore.accountId)).toHaveLength(0);
				expect((await videoRow(videoBefore))?.storagePaidUntil).toBeNull();
				expect(await balanceOf(appBefore.accountId)).toBe(1_000_000);
				const rows = await firstMonthRows(appAt.accountId);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({ referenceId: videoAt });
				expect((await videoRow(videoAt))?.storagePaidUntil).not.toBeNull();
				expect((await getAppStorage(appAt.appId)).firstMonthMicroCredits).toBe(
					0,
				);
			});

			it("never charges a video deleted mid-encode that was created a second before the first charge, and charges one created at or after it once", async () => {
				await charged(new Date("2020-02-09T00:00:00Z"), FIRST_CHARGE);
				const encodeAt = async (createdAt: Date) => {
					const app = await makeApp(1_000_000);
					const videoId = await track(app.appId, {
						createdAt,
						status: "processing",
						duration: 600,
						processing: encoding(),
					});
					await database()
						.update(developerVideos)
						.set({ deletedAt: new Date() })
						.where(eq(developerVideos.id, videoId));
					return { ...app, videoId };
				};
				const early = await encodeAt(before);
				const atStart = await encodeAt(FIRST_CHARGE);
				const later = await encodeAt(after);

				expect(await settleFirstMonthAtDelete(early.videoId)).toMatchObject({
					state: "exempt",
				});
				expect(await firstMonthRows(early.accountId)).toHaveLength(0);
				for (const video of [atStart, later]) {
					expect(await settleFirstMonthAtDelete(video.videoId)).toMatchObject({
						state: "charged",
					});
					expect(await settleFirstMonthAtDelete(video.videoId)).toEqual({
						state: "skipped",
						reason: "already_settled",
					});
					expect(await firstMonthRows(video.accountId)).toHaveLength(1);
				}
			});
		});
	},
);
