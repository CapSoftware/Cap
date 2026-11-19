import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
	balance: 0,
	heldMicroCredits: 0,
	reads: [] as string[],
	owner: "user-1",
	transactions: [] as Record<string, unknown>[],
	lock: Promise.resolve(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: async (run: (tx: unknown) => Promise<unknown>) => {
			let release: (() => void) | undefined;
			const lock = async () => {
				if (release) return;
				const previous = state.lock;
				state.lock = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
			};
			const read = (table: { table: string }, conditions: Row[]) => {
				if (table.table === "users") return [{ id: state.owner }];
				if (table.table === "accounts") {
					return [{ balanceMicroCredits: state.balance }];
				}
				return state.transactions.filter((row) =>
					conditions.every(
						({ field, value }) => row[field as string] === value,
					),
				);
			};
			const tx = {
				select: () => ({
					from: (table: { table: string }) => {
						const chain = {
							innerJoin: () => chain,
							where: (conditions: Row[]) => ({
								limit: () => ({
									then: (
										resolve: (rows: Row[]) => unknown,
										reject: (error: unknown) => unknown,
									) => {
										state.reads.push(`read ${table.table}`);
										return Promise.resolve(read(table, conditions)).then(
											resolve,
											reject,
										);
									},
									for: async () => {
										state.reads.push(`lock ${table.table}`);
										await lock();
										return read(table, conditions);
									},
								}),
							}),
						};
						return chain;
					},
				}),
				update: () => ({
					set: (values: { balanceMicroCredits: number }) => ({
						where: async () => {
							state.balance += values.balanceMicroCredits;
						},
					}),
				}),
				insert: () => ({
					values: async (values: Row) => {
						state.transactions.push({ ...values, ownerId: state.owner });
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
vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
vi.mock("@cap/utils", () => ({ stripe: () => ({}), userIsPro: () => true }));
vi.mock("@/lib/infra-balance", () => ({
	AVAILABLE_AFTER_FIELD: "availableAfterMicroCredits",
	heldTranscriptMicroCredits: async () => state.heldMicroCredits,
}));
vi.mock("@cap/database/schema", () => ({
	users: { table: "users", id: "id" },
	developerCreditAccounts: {
		table: "accounts",
		id: "accountId",
		ownerId: "ownerId",
		balanceMicroCredits: "balance",
	},
	developerCreditTransactions: {
		table: "transactions",
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

import {
	claimProMonthlyCredit,
	nextProCreditDate,
	PRO_MONTHLY_CREDIT_MICRO_CREDITS,
	proCreditPeriod,
} from "@/lib/infra-pro-credit";

const november = new Date("2026-11-11T12:00:00Z");
const claim = (now = november, accountId = "account-1") =>
	claimProMonthlyCredit({ userId: state.owner as never, accountId, now });

describe("Cap Pro monthly Infra credit", () => {
	beforeEach(() => {
		state.balance = 0;
		state.heldMicroCredits = 0;
		state.reads = [];
		state.owner = "user-1";
		state.transactions = [];
		state.lock = Promise.resolve();
	});

	it("is worth five dollars", () => {
		expect(PRO_MONTHLY_CREDIT_MICRO_CREDITS).toBe(500_000);
	});

	it("keys the claim to the UTC month", () => {
		expect(proCreditPeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
		expect(proCreditPeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
	});

	it("opens the next credit on the first of the following month", () => {
		expect(nextProCreditDate(november).toISOString()).toBe(
			"2026-12-01T00:00:00.000Z",
		);
		expect(
			nextProCreditDate(new Date("2026-12-15T08:00:00Z")).toISOString(),
		).toBe("2027-01-01T00:00:00.000Z");
	});

	it("records the credit available after the claim, net of held transcript credit", async () => {
		state.balance = 100_000;
		state.heldMicroCredits = 60_000;

		await claim();

		expect(state.transactions[0]?.metadata).toMatchObject({
			period: "2026-11",
			availableAfterMicroCredits: 100_000 + 500_000 - 60_000,
		});
	});

	it("locks the credit account before its first plain read, so the held credit it reads is current", async () => {
		await claim();

		const firstPlainRead = state.reads.findIndex((entry) =>
			entry.startsWith("read "),
		);
		expect(state.reads.indexOf("lock accounts")).toBeGreaterThanOrEqual(0);
		expect(state.reads.indexOf("lock accounts")).toBeLessThan(firstPlainRead);
	});

	it("adds the credit and writes one ledger row", async () => {
		const result = await claim();
		expect(result).toEqual({ claimed: true, balanceMicroCredits: 500_000 });
		expect(state.transactions).toHaveLength(1);
		expect(state.transactions[0]).toMatchObject({
			type: "pro_credit",
			amountMicroCredits: 500_000,
			balanceAfterMicroCredits: 500_000,
			referenceId: "2026-11",
			referenceType: "pro_monthly_credit",
		});
	});

	it("grants two simultaneous claims only once", async () => {
		const results = await Promise.all([claim(), claim()]);
		expect(results.filter((r) => r.claimed)).toHaveLength(1);
		expect(state.balance).toBe(500_000);
		expect(state.transactions).toHaveLength(1);
	});

	it("refuses a second claim in the same month, even for another app", async () => {
		await claim();
		expect(await claim(november, "account-2")).toEqual({
			claimed: false,
			reason: "already_claimed",
		});
		expect(state.balance).toBe(500_000);
	});

	it("grants again the following month", async () => {
		await claim();
		const next = await claim(new Date("2026-12-02T09:00:00Z"));
		expect(next.claimed).toBe(true);
		expect(state.balance).toBe(1_000_000);
	});

	it("is not blocked by another owner's claim", async () => {
		state.transactions.push({
			ownerId: "user-2",
			referenceId: "2026-11",
			referenceType: "pro_monthly_credit",
		});
		expect((await claim()).claimed).toBe(true);
	});
});
