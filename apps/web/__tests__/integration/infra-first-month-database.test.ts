import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
	developerVideos,
} from "@cap/database/schema";
import type { DeveloperVideoProcessingState } from "@cap/database/types";
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
const { firstMonthStorageMicroCredits } = await import(
	"@/lib/developer-pricing"
);
const { getInfraBilling, getInfraUploadAdmission } = await import(
	"@/lib/infra-standing"
);
const { getAppStorage, getStorageUsageByApp } = await import(
	"@/lib/infra-storage"
);
const { chargeStorageDay } = await import("@/lib/infra-storage-billing");
const {
	chargeDeveloperVideoFirstMonth,
	chargeMissedFirstMonths,
	settleFirstMonthAtDelete,
	settleFirstMonthAtReady,
	firstMonthShortfallsSince,
	markFirstMonthShortfallsNotified,
} = await import("@/lib/infra-storage-minimum");
const { recordAdmittedInfraUpload } = await import("@/lib/infra-video-upload");
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

			const found = await firstMonthShortfallsSince([accountId], since);
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
				(await firstMonthShortfallsSince([accountId], since)).get(accountId)
					?.ids,
			).toEqual([first?.id]);

			await markFirstMonthShortfallsNotified(
				found.get(accountId)?.ids ?? [],
				new Date(),
			);
			await markFirstMonthShortfallsNotified(
				found.get(accountId)?.ids ?? [],
				new Date(Date.now() + 60_000),
			);
			expect(await firstMonthShortfallsSince([accountId], since)).toEqual(
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
	},
);
