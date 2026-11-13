import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	balance: 0,
	transactions: [] as Record<string, unknown>[],
	lock: Promise.resolve(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: async (run: (tx: unknown) => Promise<unknown>) => {
			let release: (() => void) | undefined;
			async function lock() {
				if (release) return;
				const previous = state.lock;
				state.lock = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
			}
			const tx = {
				select: () => ({
					from: (table: { balanceMicroCredits?: string }) => ({
						where: (conditions: { field: string; value: unknown }[]) => ({
							limit: () => {
								const read = () =>
									table.balanceMicroCredits !== undefined
										? [{ balanceMicroCredits: state.balance }]
										: state.transactions.filter((row) =>
												conditions.every(
													({ field, value }) => row[field] === value,
												),
											);
								return Object.assign(Promise.resolve(read()), {
									for: async () => {
										if (table.balanceMicroCredits !== undefined) await lock();
										return read();
									},
								});
							},
						}),
					}),
				}),
				update: () => ({
					set: (values: { balanceMicroCredits: number }) => ({
						where: async () => {
							await lock();
							state.balance += values.balanceMicroCredits;
						},
					}),
				}),
				insert: () => ({
					values: async (values: Record<string, unknown>) => {
						state.transactions.push(values);
					},
				}),
			};
			try {
				return await run(tx);
			} finally {
				release?.();
			}
		},
	}),
}));

vi.mock("@cap/database/helpers", () => ({ nanoId: () => "txn" }));
vi.mock("@cap/database/schema", () => ({
	developerCreditAccounts: { id: "id", balanceMicroCredits: "balance" },
	developerCreditTransactions: {
		id: "id",
		accountId: "accountId",
		referenceId: "referenceId",
		referenceType: "referenceType",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => conditions,
	eq: (field: string, value: unknown) => ({ field, value }),
	sql: (_strings: TemplateStringsArray, _column: unknown, amount: number) =>
		amount,
}));

import { addCreditsToAccount } from "@/lib/developer-credits";

const purchase = {
	accountId: "account-1",
	amountCents: 2500,
	referenceId: "pi_purchase",
	referenceType: "stripe_payment_intent" as const,
};

describe("developer credit purchase idempotency", () => {
	beforeEach(() => {
		state.balance = 0;
		state.transactions = [];
		state.lock = Promise.resolve();
	});

	it("grants a concurrently delivered purchase only once", async () => {
		await Promise.all([
			addCreditsToAccount(purchase),
			addCreditsToAccount(purchase),
		]);
		expect(state.balance).toBe(2_500_000);
		expect(state.transactions).toHaveLength(1);
	});

	it("returns the current balance when a purchase is retried", async () => {
		await addCreditsToAccount(purchase);
		state.balance -= 1000;
		expect(await addCreditsToAccount(purchase)).toBe(2_499_000);
		expect(state.transactions).toHaveLength(1);
	});

	it("grants distinct purchases on the same account", async () => {
		await Promise.all([
			addCreditsToAccount(purchase),
			addCreditsToAccount({ ...purchase, referenceId: "pi_other" }),
		]);
		expect(state.balance).toBe(5_000_000);
		expect(state.transactions).toHaveLength(2);
	});

	it.each([
		{ accountId: "another-account", referenceType: "stripe_payment_intent" },
		{ accountId: purchase.accountId, referenceType: "manual" },
	])("does not match an unrelated transaction: %o", async (reference) => {
		state.transactions.push({
			...reference,
			referenceId: purchase.referenceId,
		});
		await addCreditsToAccount(purchase);
		expect(state.balance).toBe(2_500_000);
		expect(state.transactions).toHaveLength(2);
	});

	it("allows repeated top-ups without payment references", async () => {
		await addCreditsToAccount({
			accountId: purchase.accountId,
			amountCents: 500,
		});
		await addCreditsToAccount({
			accountId: purchase.accountId,
			amountCents: 500,
		});
		expect(state.balance).toBe(1_000_000);
		expect(state.transactions).toHaveLength(2);
	});
});
