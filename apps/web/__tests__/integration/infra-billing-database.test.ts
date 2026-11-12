import { randomUUID } from "node:crypto";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
	developerVideos,
} from "@cap/database/schema";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	probe: vi.fn(),
	objects: new Map<string, Date>(),
	headed: [] as string[],
	deleted: [] as string[],
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
vi.mock("@/lib/developer-video-storage", () => ({
	headDeveloperVideoObject: async () => ({ bytes: 1_000 }),
	internalDeveloperVideoUrl: async (key: string) => `https://storage/${key}`,
}));
vi.mock("@/lib/media-client", () => ({
	tryProbeVideoViaMediaServer: fixture.probe,
}));
vi.mock("@/lib/media-container", () => ({
	sniffMediaUrl: async () => "media",
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {
		getBucketAccess: () =>
			Effect.succeed([
				{
					headObject: (key: string) => {
						fixture.headed.push(key);
						const modified = fixture.objects.get(key);
						return modified
							? Effect.succeed({ LastModified: modified })
							: Effect.fail(new Error("not found"));
					},
					deleteObject: (key: string) => {
						fixture.deleted.push(key);
						fixture.objects.delete(key);
						return Effect.succeed({});
					},
				},
			]),
	},
}));
vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/process-developer-video", () => ({
	processDeveloperVideoWorkflow: "workflow",
}));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const HOUR_MS = 60 * 60 * 1000;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

describe.runIf(Boolean(databaseUrl))(
	"Cap Infra billing against a real database",
	() => {
		let pool: Pool;
		const apps: string[] = [];

		const makeApp = async (balanceMicroCredits: number) => {
			const appId = id();
			const accountId = id();
			apps.push(appId);
			await database()
				.insert(developerCreditAccounts)
				.values({
					id: accountId,
					appId,
					ownerId: id() as never,
					balanceMicroCredits,
				});
			return { appId, accountId };
		};

		const balanceOf = async (accountId: string) => {
			const [row] = await database()
				.select({ balance: developerCreditAccounts.balanceMicroCredits })
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, accountId));
			return row?.balance;
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
					"Infra billing tests require a session-scoped local database.",
				);
			}
			pool = createPool(databaseUrl);
			fixture.database = drizzle(pool);
			await database().select().from(developerVideos).limit(1);
		});

		afterAll(async () => {
			if (fixture.database && apps.length > 0) {
				const accounts = await database()
					.select({ id: developerCreditAccounts.id })
					.from(developerCreditAccounts)
					.where(inArray(developerCreditAccounts.appId, apps));
				if (accounts.length > 0) {
					await database()
						.delete(developerCreditTransactions)
						.where(
							inArray(
								developerCreditTransactions.accountId,
								accounts.map((account) => account.id),
							),
						);
				}
				await database()
					.delete(developerDailyStorageSnapshots)
					.where(inArray(developerDailyStorageSnapshots.appId, apps));
				await database()
					.delete(developerVideos)
					.where(inArray(developerVideos.appId, apps));
				await database()
					.delete(developerCreditAccounts)
					.where(inArray(developerCreditAccounts.appId, apps));
			}
			await pool?.end();
			fixture.database = undefined;
		});

		it("lets exactly one of six videos measured at once take the one allowance", async () => {
			const { prepareDeveloperVideoProcessing } = await import(
				"@/lib/developer-video-processing"
			);
			const { appId } = await makeApp(1_500);
			const videos = Array.from({ length: 6 }, () => ({
				id: id(),
				encodeId: id(),
			}));
			await database()
				.insert(developerVideos)
				.values(
					videos.map((video) => ({
						id: video.id,
						appId,
						name: "race",
						duration: 60,
						width: 1920,
						height: 1080,
						s3Key: `developer/${appId}/${video.id}/video`,
						status: "processing" as const,
						playbackId: id() + id(),
						maxResolutionTier: "1080p" as const,
						processing: {
							encodeId: video.encodeId,
							startedAt: Date.now(),
							probe: null,
							hls: { state: "pending" as const },
							mp4: { state: "pending" as const },
							attempts: { hls: 0, mp4: 0 },
							unavailableChecks: 0,
							poster: null,
							bytes: { source: 0, hls: 0, mp4: 0, poster: 0 },
						},
					})),
				);
			fixture.probe.mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return {
					status: "ok",
					metadata: { duration: 3600, width: 1920, height: 1080, fps: 30 },
				};
			});

			const results = await Promise.allSettled(
				videos.map((video) =>
					prepareDeveloperVideoProcessing(video.id, video.encodeId),
				),
			);

			const admitted = results.filter(
				(result) => result.status === "fulfilled",
			);
			const refused = results.filter((result) => result.status === "rejected");
			expect(admitted).toHaveLength(1);
			expect(refused).toHaveLength(5);
			for (const result of refused) {
				expect(String((result as PromiseRejectedResult).reason)).toMatch(
					/Not enough credit.*Add at least \$\d+\.\d\d/,
				);
			}
			const rows = await database()
				.select({
					duration: developerVideos.duration,
					processing: developerVideos.processing,
				})
				.from(developerVideos)
				.where(eq(developerVideos.appId, appId));
			expect(rows.filter((row) => row.duration === 3600)).toHaveLength(1);
			expect(rows.filter((row) => row.duration === 60)).toHaveLength(5);
			expect(rows.filter((row) => row.processing?.probe)).toHaveLength(1);
		});

		it("sweeps every unfinished video across pages and removes by the file's age only", async () => {
			const { removeUnrecordedInfraFiles } = await import(
				"@/lib/infra-video-upload"
			);
			const { appId } = await makeApp(0);
			const now = new Date();
			const daysAgo = (days: number) =>
				new Date(now.getTime() - days * 24 * HOUR_MS);
			const key = (videoId: string) => `developer/${appId}/${videoId}/video`;
			const row = (createdAt: Date, duration: number | null = null) => {
				const videoId = id();
				return {
					id: videoId,
					appId,
					name: "sweep",
					duration,
					s3Key: key(videoId),
					playbackId: id() + id(),
					createdAt,
				};
			};
			const lateFile = row(daysAgo(30));
			const staleFile = row(daysAgo(30));
			const noFile = row(daysAgo(2));
			const recorded = row(daysAgo(30), 60);
			const tooNew = row(new Date(now.getTime() - HOUR_MS));
			const filler = Array.from({ length: 205 }, () => row(daysAgo(9)));
			await database()
				.insert(developerVideos)
				.values([lateFile, staleFile, noFile, recorded, tooNew, ...filler]);
			fixture.objects.clear();
			fixture.objects.set(lateFile.s3Key, new Date(now.getTime() - HOUR_MS));
			fixture.objects.set(
				staleFile.s3Key,
				new Date(now.getTime() - 25 * HOUR_MS),
			);
			fixture.objects.set(
				recorded.s3Key,
				new Date(now.getTime() - 25 * HOUR_MS),
			);
			fixture.headed = [];
			fixture.deleted = [];

			const removed = await removeUnrecordedInfraFiles(now, "k");

			const mine = fixture.headed.filter((headed) =>
				headed.startsWith(`developer/${appId}/`),
			);
			expect(removed).toBe(1);
			expect(fixture.deleted).toEqual([staleFile.s3Key]);
			expect(mine).toHaveLength(208);
			expect(new Set(mine).size).toBe(208);
			expect(mine).not.toContain(recorded.s3Key);
			expect(mine).not.toContain(tooNew.s3Key);
			const state = async (videoId: string) => {
				const [found] = await database()
					.select({ deletedAt: developerVideos.deletedAt })
					.from(developerVideos)
					.where(eq(developerVideos.id, videoId));
				return found?.deletedAt ?? null;
			};
			expect(await state(staleFile.id)).not.toBeNull();
			expect(await state(lateFile.id)).toBeNull();
			expect(await state(recorded.id)).toBeNull();

			fixture.deleted = [];
			const nextDay = new Date(now.getTime() + 24 * HOUR_MS);

			expect(await removeUnrecordedInfraFiles(nextDay, "3")).toBe(1);
			expect(fixture.deleted).toEqual([lateFile.s3Key]);
			expect(await state(lateFile.id)).not.toBeNull();
		});

		it("does not charge a day the previous job already charged, and charges the next one", async () => {
			const { chargeStorageDay } = await import("@/lib/infra-storage-billing");
			const { getInfraAppStanding } = await import("@/lib/infra-standing");
			const { appId, accountId } = await makeApp(1_000);
			const now = new Date();
			const today = now.toISOString().slice(0, 10);
			const usage = {
				videoCount: 1,
				totalMinutes: 10,
				minutesByTier: { "1080p": 10, "1440p": 0, "2160p": 0 },
				monthlyMicroCredits: 850,
				dailyMicroCredits: 28,
			};
			const charge = (dateKey: string) =>
				chargeStorageDay({ appId, accountId, usage, dateKey, now });
			const oldRow = id();
			await database()
				.insert(developerCreditTransactions)
				.values({
					id: oldRow,
					accountId,
					type: "storage_daily",
					amountMicroCredits: -26,
					balanceAfterMicroCredits: 1_000,
					referenceType: "manual",
					metadata: {
						snapshotDate: today,
						totalDurationMinutes: 10,
						videoCount: 1,
					},
				});
			const snapshotId = id();
			await database().insert(developerDailyStorageSnapshots).values({
				id: snapshotId,
				appId,
				snapshotDate: today,
				totalDurationMinutes: 10,
				videoCount: 1,
				microCreditsCharged: 26,
				processedAt: now,
			});

			expect(await charge(today)).toEqual({ state: "skipped" });
			expect(await balanceOf(accountId)).toBe(1_000);
			expect(await getInfraAppStanding(appId)).toEqual({
				state: "active",
				pausesAt: null,
			});

			await database()
				.delete(developerDailyStorageSnapshots)
				.where(eq(developerDailyStorageSnapshots.id, snapshotId));
			expect(await charge(today)).toEqual({ state: "skipped" });
			expect(await balanceOf(accountId)).toBe(1_000);

			await database()
				.delete(developerCreditTransactions)
				.where(eq(developerCreditTransactions.id, oldRow));
			expect(await charge(today)).toMatchObject({
				state: "billed",
				chargedMicroCredits: 28,
			});
			expect(await balanceOf(accountId)).toBe(972);
			expect(await charge(today)).toEqual({ state: "skipped" });
		});
	},
);
