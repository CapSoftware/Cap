import { randomUUID } from "node:crypto";
import type { User } from "@cap/web-domain";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_test",
}));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

describe.runIf(Boolean(databaseUrl))(
	"an owner's earlier credit purchases against a real database",
	() => {
		let pool: Pool;
		const owners: string[] = [];
		const accounts: string[] = [];

		beforeAll(() => {
			pool = createPool({ uri: databaseUrl, connectionLimit: 4 });
			fixture.database = drizzle(pool, { mode: "default" }) as MySql2Database;
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

		const makeOwner = async () => {
			const ownerId = id();
			owners.push(ownerId);
			await pool.query(
				"INSERT INTO users (id, email, activeOrganizationId) VALUES (?, ?, '')",
				[ownerId, `${ownerId}@example.com`],
			);
			return ownerId as User.UserId;
		};

		const makeAccount = async (ownerId: string) => {
			const appId = id();
			const accountId = id();
			accounts.push(accountId);
			await pool.query(
				"INSERT INTO developer_apps (id, ownerId, name, environment) VALUES (?, ?, 'History test', 'production')",
				[appId, ownerId],
			);
			await pool.query(
				"INSERT INTO developer_credit_accounts (id, appId, ownerId, balanceMicroCredits) VALUES (?, ?, ?, 0)",
				[accountId, appId, ownerId],
			);
			return accountId;
		};

		const addRow = (accountId: string, type: string, referenceType: string) =>
			pool.query(
				`INSERT INTO developer_credit_transactions (id, accountId, type, amountMicroCredits,
					balanceAfterMicroCredits, referenceId, referenceType, metadata)
				 VALUES (?, ?, ?, 0, 0, ?, ?, '{}')`,
				[id(), accountId, type, `ref_${id()}`, referenceType],
			);

		it("finds a paid purchase on any of the owner's apps and nothing else", async () => {
			const { ownerHasPaidCreditPurchase, isFirstLargeCreditPurchase } =
				await import("@/lib/infra-credit-purchase-history");

			const buyer = await makeOwner();
			await makeAccount(buyer);
			const paidApp = await makeAccount(buyer);
			await addRow(paidApp, "topup", "stripe_payment_intent");

			const other = await makeOwner();
			const otherApp = await makeAccount(other);
			await addRow(otherApp, "topup", "auto_top_up");
			await addRow(otherApp, "topup", "stripe_checkout_session");
			await addRow(otherApp, "topup", "pro_monthly_credit");
			await addRow(otherApp, "topup_failed", "auto_top_up_failed");
			await addRow(otherApp, "refund", "stripe_payment_intent");

			const stranger = await makeOwner();

			expect(await ownerHasPaidCreditPurchase(buyer)).toBe(true);
			expect(await ownerHasPaidCreditPurchase(other)).toBe(false);
			expect(await ownerHasPaidCreditPurchase(stranger)).toBe(false);
			expect(await isFirstLargeCreditPurchase(buyer, 500_000)).toBe(false);
			expect(await isFirstLargeCreditPurchase(other, 500_000)).toBe(true);
			expect(await isFirstLargeCreditPurchase(other, 100_000)).toBe(false);
		});

		it("reads the owner's accounts and their purchases by index", async () => {
			const ownerId = await makeOwner();
			const [rows] = await pool.query(
				`EXPLAIN SELECT t.id FROM developer_credit_accounts a
				 INNER JOIN developer_credit_transactions t ON t.accountId = a.id
				 WHERE a.ownerId = ? AND t.type = 'topup' AND t.referenceType = 'stripe_payment_intent'
				 LIMIT 1`,
				[ownerId],
			);
			const plan = rows as { table: string; key: string | null }[];
			expect(plan.find((row) => row.table === "a")?.key).toBe("owner_idx");
			expect(plan.find((row) => row.table === "t")?.key).toMatch(
				/^account_(type_created|created|ref_dedup)_idx$/,
			);
		});
	},
);
