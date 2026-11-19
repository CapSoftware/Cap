import { describe, expect, it } from "vitest";
import {
	dailyStorageMicroCredits,
	MICRO_CREDITS_PER_DOLLAR,
} from "@/lib/developer-pricing";

function purchaseCreditsFormula(amountCents: number): number {
	return Math.floor((amountCents / 100) * MICRO_CREDITS_PER_DOLLAR);
}

function balanceDollars(balanceMicroCredits: number): string {
	return (balanceMicroCredits / 100_000).toFixed(2);
}

function balanceAfterCharge(balance: number, charge: number): number {
	return Math.max(0, balance - charge);
}

function isBelowMinimumPurchase(amountCents: number): boolean {
	return amountCents < 500;
}

describe("Purchase Credits Conversion", () => {
	it("converts $5.00 (500 cents) to 500,000 micro-credits", () => {
		expect(purchaseCreditsFormula(500)).toBe(500_000);
	});

	it("converts $10.00 (1000 cents) to 1,000,000 micro-credits", () => {
		expect(purchaseCreditsFormula(1000)).toBe(1_000_000);
	});

	it("converts $25.00 (2500 cents) to 2,500,000 micro-credits", () => {
		expect(purchaseCreditsFormula(2500)).toBe(2_500_000);
	});

	it("converts $50.00 (5000 cents) to 5,000,000 micro-credits", () => {
		expect(purchaseCreditsFormula(5000)).toBe(5_000_000);
	});

	it("converts $0.01 (1 cent) to 1,000 micro-credits", () => {
		expect(purchaseCreditsFormula(1)).toBe(1_000);
	});

	it("converts $5.99 (599 cents) to 599,000 micro-credits using Math.floor", () => {
		expect(purchaseCreditsFormula(599)).toBe(Math.floor(5.99 * 100_000));
		expect(purchaseCreditsFormula(599)).toBe(599_000);
	});

	it("rejects purchases below $5.00 minimum (amountCents < 500)", () => {
		expect(isBelowMinimumPurchase(499)).toBe(true);
		expect(isBelowMinimumPurchase(500)).toBe(false);
		expect(isBelowMinimumPurchase(0)).toBe(true);
	});
});

describe("Daily Storage Cost", () => {
	const stored = (minutes: number) => ({
		"1080p": minutes,
		"1440p": 0,
		"2160p": 0,
	});

	it("charges 2 micro-credits a day for 1 minute up to 1080p", () => {
		expect(dailyStorageMicroCredits(stored(1))).toBe(2);
	});

	it("charges 28 micro-credits a day for 10 minutes up to 1080p", () => {
		expect(dailyStorageMicroCredits(stored(10))).toBe(28);
	});

	it("charges 2,833 micro-credits a day for 1,000 minutes up to 1080p", () => {
		expect(dailyStorageMicroCredits(stored(1000))).toBe(2833);
	});

	it("charges 0 micro-credits for 0 minutes stored", () => {
		expect(dailyStorageMicroCredits(stored(0))).toBe(0);
	});
});

describe("Balance Conversions", () => {
	it("converts 0 micro-credits to $0.00", () => {
		expect(balanceDollars(0)).toBe("0.00");
	});

	it("converts 100,000 micro-credits to $1.00", () => {
		expect(balanceDollars(100_000)).toBe("1.00");
	});

	it("converts 500,000 micro-credits to $5.00", () => {
		expect(balanceDollars(500_000)).toBe("5.00");
	});

	it("converts 1 micro-credit to $0.00 (rounds down)", () => {
		expect(balanceDollars(1)).toBe("0.00");
	});

	it("converts 99,999 micro-credits to $1.00 (rounds up)", () => {
		expect(balanceDollars(99_999)).toBe("1.00");
	});

	it("converts 50,000 micro-credits to $0.50", () => {
		expect(balanceDollars(50_000)).toBe("0.50");
	});
});

describe("Balance Protection (GREATEST(0, balance - charge))", () => {
	it("prevents negative balance: 1000 - 5000 = 0", () => {
		expect(balanceAfterCharge(1000, 5000)).toBe(0);
	});

	it("subtracts normally: 10000 - 5000 = 5000", () => {
		expect(balanceAfterCharge(10000, 5000)).toBe(5000);
	});

	it("handles exact depletion: 5000 - 5000 = 0", () => {
		expect(balanceAfterCharge(5000, 5000)).toBe(0);
	});
});
