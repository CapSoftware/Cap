import { randomUUID } from "node:crypto";
import type { DeveloperVideoProcessingState } from "@cap/database/types";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	created: [] as { id: string; metadata: Record<string, string> }[],
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "", NEXT_PUBLIC_WEB_URL: "https://web" },
	serverEnv: () => ({ WEB_URL: "https://web" }),
}));
vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_test",
}));
vi.mock("@/lib/infra-billing-emails", () => ({
	sendInfraTopUpFailedEmail: vi.fn(),
	sendInfraOutOfCreditEmail: vi.fn(async () => true),
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		paymentIntents: {
			search: async () => ({ data: [] }),
			retrieve: async (intentId: string) => {
				const intent = fixture.created.find((entry) => entry.id === intentId);
				if (!intent) throw new Error(`No such payment_intent: ${intentId}`);
				return intent;
			},
			create: async (params: {
				amount: number;
				metadata: Record<string, string>;
			}) => {
				const intent = {
					id: `pi_${randomUUID().slice(0, 8)}`,
					status: "succeeded",
					amount: params.amount,
					amount_received: params.amount,
					currency: "usd",
					metadata: params.metadata,
				};
				fixture.created.push(intent);
				return intent;
			},
		},
	}),
}));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

const processing = (): DeveloperVideoProcessingState =>
	({
		startedAt: Date.now(),
		encodeId: "encode",
		hls: { state: "complete", output: null },
		mp4: { state: "complete", output: null },
		attempts: { hls: 1, mp4: 1 },
		unavailableChecks: 0,
		poster: null,
		bytes: { source: 1, hls: 1, mp4: 1 },
	}) as unknown as DeveloperVideoProcessingState;

describe.runIf(Boolean(databaseUrl))(
	"auto top-up after a first month charge against a real database",
	() => {
		let pool: Pool;

		const makeAccount = async (balanceMicroCredits: number) => {
			const ownerId = id();
			const appId = id();
			const accountId = id();
			await pool.query(
				"INSERT INTO users (id, email, activeOrganizationId) VALUES (?, ?, '')",
				[ownerId, `${ownerId}@example.com`],
			);
			await pool.query(
				"INSERT INTO developer_apps (id, ownerId, name, environment) VALUES (?, ?, 'Top-up after first month', 'production')",
				[appId, ownerId],
			);
			await pool.query(
				`INSERT INTO developer_credit_accounts
					(id, appId, ownerId, balanceMicroCredits, stripeCustomerId, stripePaymentMethodId,
					 autoTopUpEnabled, autoTopUpThresholdMicroCredits, autoTopUpAmountCents)
				 VALUES (?, ?, ?, ?, 'cus_test', 'pm_test', 1, 500000, 500)`,
				[accountId, appId, ownerId, balanceMicroCredits],
			);
			return { appId, accountId };
		};

		const makeVideo = async (appId: string, durationSeconds: number) => {
			const videoId = id();
			const { developerVideos } = await import("@cap/database/schema");
			await (fixture.database as MySql2Database)
				.insert(developerVideos)
				.values({
					id: videoId,
					appId,
					name: "Fixture",
					status: "ready",
					duration: durationSeconds,
					width: 3840,
					height: 2160,
					maxResolutionTier: "2160p",
					processing: processing(),
					createdAt: new Date("2026-11-12T00:00:00Z"),
					updatedAt: new Date("2026-11-12T00:05:00Z"),
				});
			return videoId;
		};

		const balanceOf = async (accountId: string) => {
			const [rows] = await pool.query(
				"SELECT balanceMicroCredits AS balance FROM developer_credit_accounts WHERE id = ?",
				[accountId],
			);
			return Number((rows as { balance: number }[])[0]?.balance);
		};

		const topUpsOf = async (accountId: string) => {
			const [rows] = await pool.query(
				"SELECT id FROM developer_credit_transactions WHERE accountId = ? AND referenceType = 'auto_top_up' AND type = 'topup'",
				[accountId],
			);
			return (rows as { id: string }[]).length;
		};

		const intentsFor = (accountId: string) =>
			fixture.created.filter(
				(intent) => intent.metadata.accountId === accountId,
			).length;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_(infra|speech)_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error("These tests require a session-scoped local database.");
			}
			pool = createPool({ uri: databaseUrl, connectionLimit: 12 });
			fixture.database = drizzle(pool, { mode: "default" }) as MySql2Database;
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("schedules exactly one top-up for a charged month that crosses the threshold, and none for a repeat or a month above it", async () => {
			const { chargeDeveloperVideoFirstMonth } = await import(
				"@/lib/infra-storage-minimum"
			);
			const { appId, accountId } = await makeAccount(510_000);
			const videoId = await makeVideo(appId, 14_400);

			const charged = await chargeDeveloperVideoFirstMonth(videoId);
			expect(charged).toMatchObject({
				state: "charged",
				chargedMicroCredits: 67_200,
			});
			expect(intentsFor(accountId)).toBe(1);
			expect(await topUpsOf(accountId)).toBe(1);
			expect(await balanceOf(accountId)).toBe(942_800);

			expect(await chargeDeveloperVideoFirstMonth(videoId)).toMatchObject({
				state: "skipped",
			});
			const above = await makeVideo(appId, 600);
			expect(await chargeDeveloperVideoFirstMonth(above)).toMatchObject({
				state: "charged",
				chargedMicroCredits: 2_800,
			});
			expect(intentsFor(accountId)).toBe(1);
			expect(await topUpsOf(accountId)).toBe(1);
		});

		it("does not wait on the top-up inside a caller's transaction that holds the account lock, and tops up once it commits", async () => {
			const { chargeDeveloperVideoFirstMonth } = await import(
				"@/lib/infra-storage-minimum"
			);
			const { lockInfraAccount } = await import("@/lib/infra-balance");
			const { appId, accountId } = await makeAccount(510_000);
			const videoId = await makeVideo(appId, 14_400);
			const database = fixture.database as MySql2Database;

			const started = Date.now();
			await database.transaction(async (tx) => {
				await lockInfraAccount(tx, appId);
				expect(
					await chargeDeveloperVideoFirstMonth(videoId, { executor: tx }),
				).toMatchObject({ state: "charged", chargedMicroCredits: 67_200 });
				expect(intentsFor(accountId)).toBe(0);
			});
			expect(Date.now() - started).toBeLessThan(5_000);

			for (let i = 0; i < 50 && (await topUpsOf(accountId)) === 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(intentsFor(accountId)).toBe(1);
			expect(await topUpsOf(accountId)).toBe(1);
		});

		it("charges a month with no top-up when the balance pays nothing", async () => {
			const { chargeDeveloperVideoFirstMonth } = await import(
				"@/lib/infra-storage-minimum"
			);
			const { appId, accountId } = await makeAccount(0);
			await pool.query(
				"UPDATE developer_credit_accounts SET autoTopUpEnabled = 1 WHERE id = ?",
				[accountId],
			);
			const videoId = await makeVideo(appId, 600);

			expect(await chargeDeveloperVideoFirstMonth(videoId)).toMatchObject({
				state: "charged",
				chargedMicroCredits: 0,
			});
			expect(intentsFor(accountId)).toBe(0);
		});
	},
);
