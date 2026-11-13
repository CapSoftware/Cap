import type { User } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_credits",
}));

import {
	CREDIT_CHECKOUT_3DS_OVER_CENTS,
	creditCheckoutSessionParams,
} from "@/lib/infra-credit-checkout";
import {
	isFirstLargeCreditPurchase,
	ownerHasPaidCreditPurchase,
} from "@/lib/infra-credit-purchase-history";

const OWNER = "owner-1" as User.UserId;
const dialect = new MySqlDialect();

const reader = (rows: { id: string }[]) => {
	const seen = { where: undefined as SQL | undefined, selects: 0 };
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		where: (where: SQL) => {
			seen.where = where;
			return chain;
		},
		limit: async () => rows,
	};
	const database = {
		select: () => {
			seen.selects += 1;
			return chain;
		},
	} as unknown as Parameters<typeof ownerHasPaidCreditPurchase>[1];
	return { database, seen };
};

const params = (firstLargePurchase: boolean) =>
	creditCheckoutSessionParams({
		customerId: "cus_1",
		accountId: "account-1",
		appName: "Course site",
		amountCents: 500_000,
		receiptEmail: "owner@example.com",
		firstLargePurchase,
	});

describe("a first large credit purchase", () => {
	it("starts above $1,000: exactly $1,000 never asks, $1,000.01 does", async () => {
		expect(CREDIT_CHECKOUT_3DS_OVER_CENTS).toBe(100_000);

		const atLimit = reader([]);
		expect(
			await isFirstLargeCreditPurchase(OWNER, 100_000, atLimit.database),
		).toBe(false);
		expect(atLimit.seen.selects).toBe(0);

		const overLimit = reader([]);
		expect(
			await isFirstLargeCreditPurchase(OWNER, 100_001, overLimit.database),
		).toBe(true);
		expect(overLimit.seen.selects).toBe(1);
	});

	it("is not a first purchase once the owner has paid for credit on any app", async () => {
		const paid = reader([{ id: "txn-1" }]);
		expect(
			await isFirstLargeCreditPurchase(OWNER, 1_000_000, paid.database),
		).toBe(false);
	});

	it("counts only paid manual purchases across every account the owner has", async () => {
		const { database, seen } = reader([]);
		await ownerHasPaidCreditPurchase(OWNER, database);
		if (!seen.where) throw new Error("no where clause");
		const query = dialect.sqlToQuery(seen.where);

		expect(query.sql).toBe(
			"(`developer_credit_accounts`.`ownerId` = ? and `developer_credit_transactions`.`type` = ? and `developer_credit_transactions`.`referenceType` = ?)",
		);
		expect(query.params).toEqual([OWNER, "topup", "stripe_payment_intent"]);
	});

	it("offers card only and asks for 3D Secure on a first large purchase", () => {
		const large = params(true);
		expect(large.payment_method_types).toEqual(["card"]);
		expect(large.payment_method_options).toEqual({
			card: { request_three_d_secure: "any" },
		});
	});

	it("keeps card and Link and sets no card options otherwise", () => {
		const regular = params(false);
		expect(regular.payment_method_types).toEqual(["card", "link"]);
		expect(regular).not.toHaveProperty("payment_method_options");
		const { payment_method_types, payment_method_options, ...rest } =
			params(true);
		const { payment_method_types: regularTypes, ...regularRest } = regular;
		expect(rest).toEqual(regularRest);
		expect(payment_method_options).toBeDefined();
		expect(payment_method_types).not.toEqual(regularTypes);
	});
});
