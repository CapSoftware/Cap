import { randomUUID } from "node:crypto";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type FakeIntent = {
	id: string;
	status: "succeeded";
	amount: number;
	amount_received: number;
	currency: string;
	metadata: Record<string, string>;
};

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	keys: new Map<
		string,
		| { state: "pending"; params: string }
		| { state: "done"; params: string; intent: FakeIntent }
	>(),
	created: [] as FakeIntent[],
	createdKeys: [] as string[],
	loseNextResponse: false,
	stored: new Map<string, FakeIntent>(),
	retrieved: [] as string[],
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
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		paymentIntents: {
			retrieve: async (id: string) => {
				fixture.retrieved.push(id);
				const intent = fixture.stored.get(id);
				if (!intent) throw new Error(`No such payment_intent: ${id}`);
				return intent;
			},
			create: async (
				params: { amount: number; metadata: Record<string, string> },
				options: { idempotencyKey: string },
			) => {
				const key = options.idempotencyKey;
				const entry = fixture.keys.get(key);
				const sent = JSON.stringify(params);
				if (entry && entry.params !== sent) {
					throw Object.assign(new Error("Keys must match parameters"), {
						type: "StripeIdempotencyError",
						statusCode: 400,
					});
				}
				if (entry?.state === "pending") {
					throw Object.assign(new Error("Key in use"), {
						type: "StripeInvalidRequestError",
						code: "idempotency_key_in_use",
						statusCode: 409,
					});
				}
				if (entry?.state === "done") return entry.intent;
				fixture.keys.set(key, { state: "pending", params: sent });
				await new Promise((resolve) => setTimeout(resolve, 40));
				const intent: FakeIntent = {
					id: `pi_${fixture.created.length + 1}`,
					status: "succeeded",
					amount: params.amount,
					amount_received: params.amount,
					currency: "usd",
					metadata: params.metadata,
				};
				fixture.created.push(intent);
				fixture.createdKeys.push(key);
				fixture.keys.set(key, { state: "done", params: sent, intent });
				if (fixture.loseNextResponse) {
					fixture.loseNextResponse = false;
					throw Object.assign(new Error("Request aborted due to timeout"), {
						type: "StripeConnectionError",
					});
				}
				return intent;
			},
		},
	}),
}));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

describe.runIf(Boolean(databaseUrl))(
	"Cap Infra auto top-up against a real database",
	() => {
		let pool: Pool;
		const accounts: string[] = [];
		const owners: string[] = [];

		const makeOwner = async () => {
			const userId = id();
			owners.push(userId);
			await pool.query(
				"INSERT INTO users (id, email, activeOrganizationId) VALUES (?, ?, '')",
				[userId, `${userId}@example.com`],
			);
			return userId;
		};

		const makeAccount = async (
			balanceMicroCredits: number,
			{
				ownerId,
				amountCents = 500,
			}: { ownerId?: string; amountCents?: number } = {},
		) => {
			const userId = ownerId ?? (await makeOwner());
			const appId = id();
			const accountId = id();
			accounts.push(accountId);
			await pool.query(
				"INSERT INTO developer_apps (id, ownerId, name, environment) VALUES (?, ?, 'Top-up test', 'production')",
				[appId, userId],
			);
			await pool.query(
				`INSERT INTO developer_credit_accounts
					(id, appId, ownerId, balanceMicroCredits, stripeCustomerId, stripePaymentMethodId,
					 autoTopUpEnabled, autoTopUpThresholdMicroCredits, autoTopUpAmountCents)
				 VALUES (?, ?, ?, ?, 'cus_test', 'pm_test', 1, 500000, ?)`,
				[accountId, appId, userId, balanceMicroCredits, amountCents],
			);
			return { accountId, appId, ownerId: userId };
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
				"SELECT referenceId FROM developer_credit_transactions WHERE accountId = ? AND referenceType = 'auto_top_up' AND type = 'topup'",
				[accountId],
			);
			return (rows as { referenceId: string }[]).map((row) => row.referenceId);
		};

		const setBalance = (accountId: string, balanceMicroCredits: number) =>
			pool.query(
				"UPDATE developer_credit_accounts SET balanceMicroCredits = ? WHERE id = ?",
				[balanceMicroCredits, accountId],
			);

		beforeAll(() => {
			pool = createPool({ uri: databaseUrl, connectionLimit: 12 });
			fixture.database = drizzle(pool, {
				mode: "default",
			}) as MySql2Database;
		});

		afterAll(async () => {
			for (const accountId of accounts) {
				await pool.query(
					"DELETE FROM developer_credit_transactions WHERE accountId = ?",
					[accountId],
				);
				await pool.query(
					"DELETE a, c FROM developer_credit_accounts c JOIN developer_apps a ON a.id = c.appId WHERE c.id = ?",
					[accountId],
				);
			}
			for (const ownerId of owners) {
				await pool.query("DELETE FROM users WHERE id = ?", [ownerId]);
			}
			await pool.end();
		});

		it("creates one charge when several triggers race for one account", async () => {
			const { runAutoTopUp } = await import("@/lib/infra-auto-top-up");
			const { accountId } = await makeAccount(30_000);
			const before = fixture.created.length;

			const early = Array.from({ length: 6 }, () => runAutoTopUp(accountId));
			await new Promise((resolve) => setTimeout(resolve, 60));
			const late = Array.from({ length: 4 }, () => runAutoTopUp(accountId));
			const results = await Promise.all([...early, ...late]);

			expect(fixture.created.length - before).toBe(1);
			expect(await topUpsOf(accountId)).toHaveLength(1);
			expect(await balanceOf(accountId)).toBe(530_000);
			expect(
				results.filter((result) => result.state === "succeeded").length,
			).toBeGreaterThanOrEqual(1);
			for (const result of results) {
				expect(["succeeded", "skipped"]).toContain(result.state);
			}
		});

		it("creates one charge when the amount changes while triggers race", async () => {
			const { runAutoTopUp } = await import("@/lib/infra-auto-top-up");
			const { accountId } = await makeAccount(30_000);
			const before = fixture.created.length;

			const first = Array.from({ length: 4 }, () => runAutoTopUp(accountId));
			await new Promise((resolve) => setTimeout(resolve, 10));
			await pool.query(
				"UPDATE developer_credit_accounts SET autoTopUpAmountCents = 2500 WHERE id = ?",
				[accountId],
			);
			const changed = Array.from({ length: 4 }, () => runAutoTopUp(accountId));
			await Promise.all([...first, ...changed]);

			expect(fixture.created.length - before).toBe(1);
			expect(await topUpsOf(accountId)).toHaveLength(1);
			expect(await balanceOf(accountId)).toBe(530_000);
		});

		it("makes no second payment when the amount changes after a lost response", async () => {
			const { runAutoTopUp, settleAutoTopUpPaymentIntent } = await import(
				"@/lib/infra-auto-top-up"
			);
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const { accountId } = await makeAccount(30_000);
			const before = fixture.created.length;

			fixture.loseNextResponse = true;
			expect(await runAutoTopUp(accountId)).toEqual({ state: "error" });
			expect(await topUpsOf(accountId)).toHaveLength(0);

			await pool.query(
				"UPDATE developer_credit_accounts SET autoTopUpAmountCents = 2500 WHERE id = ?",
				[accountId],
			);
			expect(await runAutoTopUp(accountId)).toEqual({
				state: "skipped",
				reason: "in_progress",
			});
			expect(fixture.created.length - before).toBe(1);

			const [lost] = fixture.created.slice(before);
			if (!lost) throw new Error("No payment was created");
			await settleAutoTopUpPaymentIntent(
				lost as unknown as Parameters<typeof settleAutoTopUpPaymentIntent>[0],
				"succeeded",
			);
			await setBalance(accountId, 10);
			expect(await runAutoTopUp(accountId)).toMatchObject({
				state: "succeeded",
			});
			expect(
				fixture.created.slice(before).map((intent) => intent.amount),
			).toEqual([500, 2500]);
			errors.mockRestore();
		});

		const addRow = (
			accountId: string,
			type: string,
			referenceType: string,
			referenceId: string,
			hoursAgo: number,
		) =>
			pool.query(
				`INSERT INTO developer_credit_transactions (id, accountId, type, amountMicroCredits,
					balanceAfterMicroCredits, referenceId, referenceType, metadata, createdAt)
				 VALUES (?, ?, ?, 0, 30000, ?, ?, '{}', UTC_TIMESTAMP() - INTERVAL ? HOUR)`,
				[id(), accountId, type, referenceId, referenceType, hoursAgo],
			);

		it("makes the locked check wait on the same rules the sweep reads", async () => {
			const { runAutoTopUp } = await import("@/lib/infra-auto-top-up");
			const declined = await makeAccount(30_000);
			await addRow(
				declined.accountId,
				"topup_failed",
				"auto_top_up_failed",
				`declined-${declined.accountId}`,
				2,
			);
			const young = await makeAccount(30_000);
			await addRow(
				young.accountId,
				"topup_pending",
				"auto_top_up_pending",
				`pi_young_${young.accountId}`,
				25,
			);
			const old = await makeAccount(30_000);
			const oldPayment = `pi_old_${old.accountId}`;
			await addRow(
				old.accountId,
				"topup_pending",
				"auto_top_up_pending",
				oldPayment,
				73,
			);
			fixture.stored.set(oldPayment, {
				id: oldPayment,
				status: "succeeded",
				amount: 500,
				amount_received: 500,
				currency: "usd",
				metadata: { type: "developer_auto_top_up", accountId: old.accountId },
			});
			const before = fixture.created.length;

			expect(await runAutoTopUp(declined.accountId)).toEqual({
				state: "skipped",
				reason: "recent_decline",
			});
			expect(await runAutoTopUp(young.accountId)).toEqual({
				state: "skipped",
				reason: "awaiting_payment",
			});
			expect(await runAutoTopUp(old.accountId)).toEqual({
				state: "skipped",
				reason: "reconciled",
			});
			expect(await topUpsOf(old.accountId)).toEqual([oldPayment]);
			expect(fixture.created.length).toBe(before);
		});

		it("lets the sweep reconcile a payment pending for over 72 hours, and only that", async () => {
			const { runDueAutoTopUps } = await import("@/lib/infra-auto-top-up");

			const stale = await makeAccount(30_000);
			const stalePayment = `pi_stale_${stale.accountId}`;
			await addRow(
				stale.accountId,
				"topup_pending",
				"auto_top_up_pending",
				stalePayment,
				73,
			);
			fixture.stored.set(stalePayment, {
				id: stalePayment,
				status: "succeeded",
				amount: 500,
				amount_received: 500,
				currency: "usd",
				metadata: { type: "developer_auto_top_up", accountId: stale.accountId },
			});
			const young = await makeAccount(30_000);
			await addRow(
				young.accountId,
				"topup_pending",
				"auto_top_up_pending",
				`pi_young_${young.accountId}`,
				25,
			);
			const declined = await makeAccount(30_000);
			await addRow(
				declined.accountId,
				"topup_failed",
				"auto_top_up_failed",
				`declined-${declined.accountId}`,
				2,
			);
			const free = await makeAccount(30_000);
			const before = fixture.created.length;

			await runDueAutoTopUps(new Date());

			expect(fixture.retrieved).not.toContain(`pi_young_${young.accountId}`);
			expect(fixture.retrieved.at(-1)).toBe(stalePayment);
			expect(await topUpsOf(stale.accountId)).toEqual([stalePayment]);
			expect(await topUpsOf(young.accountId)).toEqual([]);
			expect(await topUpsOf(declined.accountId)).toEqual([]);
			expect(await topUpsOf(free.accountId)).toHaveLength(1);
			const charged = fixture.created
				.slice(before)
				.map((intent) => intent.metadata.accountId);
			expect(charged).toContain(free.accountId);
			expect(charged).not.toContain(stale.accountId);
			expect(charged).not.toContain(young.accountId);
			expect(charged).not.toContain(declined.accountId);
		});

		it("stops an owner's automatic top-ups at $1,000 a day across all their apps", async () => {
			const { runAutoTopUp } = await import("@/lib/infra-auto-top-up");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const ownerId = await makeOwner();
			const first = await makeAccount(30_000, { ownerId, amountCents: 60_000 });
			const second = await makeAccount(30_000, {
				ownerId,
				amountCents: 60_000,
			});
			const before = fixture.created.length;

			expect((await runAutoTopUp(first.accountId)).state).toBe("succeeded");
			expect(await runAutoTopUp(second.accountId)).toEqual({
				state: "skipped",
				reason: "owner_daily_limit",
			});

			expect(fixture.created.length - before).toBe(1);
			const [[enabled]] = (await pool.query(
				"SELECT autoTopUpEnabled AS on_ FROM developer_credit_accounts WHERE id = ?",
				[second.accountId],
			)) as unknown as [[{ on_: number }]];
			expect(enabled.on_).toBe(1);
			expect(warn).toHaveBeenCalledWith(
				"[infra-billing] Auto top-up waits for its daily limit",
				{ accountId: second.accountId, reason: "owner_daily_limit" },
			);
			warn.mockRestore();
		});

		it("lets two apps of one owner racing near the ceiling make one charge", async () => {
			const { runAutoTopUp } = await import("@/lib/infra-auto-top-up");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const ownerId = await makeOwner();
			const first = await makeAccount(30_000, { ownerId, amountCents: 60_000 });
			const second = await makeAccount(30_000, {
				ownerId,
				amountCents: 60_000,
			});
			const before = fixture.created.length;

			const results = await Promise.all([
				runAutoTopUp(first.accountId),
				runAutoTopUp(second.accountId),
			]);

			expect(fixture.created.length - before).toBe(1);
			expect(results.map((result) => result.state).sort()).toEqual([
				"skipped",
				"succeeded",
			]);
			expect(results).toContainEqual({
				state: "skipped",
				reason: "owner_daily_limit",
			});
			warn.mockRestore();
		});

		it("leaves credit bought by hand out of the owner's ceiling", async () => {
			const { runAutoTopUp } = await import("@/lib/infra-auto-top-up");
			const ownerId = await makeOwner();
			const bought = await makeAccount(30_000, { ownerId });
			const automatic = await makeAccount(30_000, {
				ownerId,
				amountCents: 60_000,
			});
			await pool.query(
				`INSERT INTO developer_credit_transactions (id, accountId, type, amountMicroCredits,
					balanceAfterMicroCredits, referenceId, referenceType, metadata)
				 VALUES (?, ?, 'topup', 90000000, 90030000, ?, 'stripe_payment_intent', '{}')`,
				[id(), bought.accountId, `pi_manual_${bought.accountId}`],
			);

			expect((await runAutoTopUp(automatic.accountId)).state).toBe("succeeded");
		});

		it("tops up again the same day with a new key once the balance is low again", async () => {
			const { runAutoTopUp } = await import("@/lib/infra-auto-top-up");
			const { accountId } = await makeAccount(30_000);
			const before = fixture.created.length;

			expect((await runAutoTopUp(accountId)).state).toBe("succeeded");
			expect((await runAutoTopUp(accountId)).state).toBe("skipped");
			await setBalance(accountId, 10);
			expect((await runAutoTopUp(accountId)).state).toBe("succeeded");

			const keys = fixture.createdKeys.slice(before);
			expect(keys).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
			expect(await topUpsOf(accountId)).toHaveLength(2);
		});

		it("stops at the daily limit of automatic top-ups", async () => {
			const { AUTO_TOP_UP_DAILY_LIMIT, runAutoTopUp } = await import(
				"@/lib/infra-auto-top-up"
			);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { accountId } = await makeAccount(30_000);

			for (let i = 0; i < AUTO_TOP_UP_DAILY_LIMIT; i++) {
				await setBalance(accountId, 10);
				expect((await runAutoTopUp(accountId)).state).toBe("succeeded");
			}
			await setBalance(accountId, 10);
			expect(await runAutoTopUp(accountId)).toEqual({
				state: "skipped",
				reason: "daily_limit",
			});
			expect(await topUpsOf(accountId)).toHaveLength(AUTO_TOP_UP_DAILY_LIMIT);
			warn.mockRestore();
		});
	},
);
