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

		const makeAccount = async (balanceMicroCredits: number) => {
			const userId = id();
			const appId = id();
			const accountId = id();
			accounts.push(accountId);
			await pool.query(
				"INSERT INTO users (id, email, activeOrganizationId) VALUES (?, ?, '')",
				[userId, `${userId}@example.com`],
			);
			await pool.query(
				"INSERT INTO developer_apps (id, ownerId, name, environment) VALUES (?, ?, 'Top-up test', 'production')",
				[appId, userId],
			);
			await pool.query(
				`INSERT INTO developer_credit_accounts
					(id, appId, ownerId, balanceMicroCredits, stripeCustomerId, stripePaymentMethodId,
					 autoTopUpEnabled, autoTopUpThresholdMicroCredits, autoTopUpAmountCents)
				 VALUES (?, ?, ?, ?, 'cus_test', 'pm_test', 1, 500000, 500)`,
				[accountId, appId, userId, balanceMicroCredits],
			);
			return { accountId, appId };
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
					"DELETE a, c, u FROM developer_credit_accounts c JOIN developer_apps a ON a.id = c.appId JOIN users u ON u.id = c.ownerId WHERE c.id = ?",
					[accountId],
				);
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
