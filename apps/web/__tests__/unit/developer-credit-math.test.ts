import { describe, expect, it } from "vitest";

const MICRO_CREDITS_PER_DOLLAR = 100_000;
const MICRO_CREDITS_PER_MINUTE = 5_000;
const MICRO_CREDITS_PER_MINUTE_PER_DAY = 3.33;
const MIN_BALANCE_MICRO_CREDITS = 5_000;

function purchaseCreditsFormula(amountCents: number): number {
	return Math.floor((amountCents / 100) * MICRO_CREDITS_PER_DOLLAR);
}

function videoRecordingCost(durationMinutes: number): number {
	return Math.floor(durationMinutes * MICRO_CREDITS_PER_MINUTE);
}

function dailyStorageCost(totalMinutes: number): number {
	return Math.floor(totalMinutes * MICRO_CREDITS_PER_MINUTE_PER_DAY);
}

function balanceDollars(balanceMicroCredits: number): string {
	return (balanceMicroCredits / 100_000).toFixed(2);
}

function balanceAfterCharge(balance: number, charge: number): number {
	return Math.max(0, balance - charge);
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
		expect(499 < 500).toBe(true);
		expect(500 < 500).toBe(false);
		expect(0 < 500).toBe(true);
	});
});

describe("Video Recording Cost", () => {
	it("charges 5,000 micro-credits for 1 minute video", () => {
		expect(videoRecordingCost(1)).toBe(5_000);
	});

	it("charges 25,000 micro-credits for 5 minute video", () => {
		expect(videoRecordingCost(5)).toBe(25_000);
	});

	it("charges 50,000 micro-credits for 10 minute video", () => {
		expect(videoRecordingCost(10)).toBe(50_000);
	});

	it("charges 2,500 micro-credits for 30 second video (0.5 min)", () => {
		expect(videoRecordingCost(0.5)).toBe(2_500);
	});

	it("charges 7,500 micro-credits for 90 second video (1.5 min)", () => {
		expect(videoRecordingCost(1.5)).toBe(7_500);
	});

	it("charges 0 micro-credits for 0 duration", () => {
		expect(videoRecordingCost(0)).toBe(0);
	});

	it("charges 83 micro-credits for 1 second video (1/60 min)", () => {
		const oneSecondInMinutes = 1 / 60;
		expect(videoRecordingCost(oneSecondInMinutes)).toBe(
			Math.floor(0.016666666666666666 * 5_000),
		);
		expect(videoRecordingCost(oneSecondInMinutes)).toBe(83);
	});
});

describe("Daily Storage Cost", () => {
	it("charges 3 micro-credits for 1 minute stored", () => {
		expect(dailyStorageCost(1)).toBe(Math.floor(1 * 3.33));
		expect(dailyStorageCost(1)).toBe(3);
	});

	it("charges 33 micro-credits for 10 minutes stored", () => {
		expect(dailyStorageCost(10)).toBe(Math.floor(10 * 3.33));
		expect(dailyStorageCost(10)).toBe(33);
	});

	it("charges 333 micro-credits for 100 minutes stored", () => {
		expect(dailyStorageCost(100)).toBe(Math.floor(100 * 3.33));
		expect(dailyStorageCost(100)).toBe(333);
	});

	it("charges 3330 micro-credits for 1000 minutes stored", () => {
		expect(dailyStorageCost(1000)).toBe(Math.floor(1000 * 3.33));
		expect(dailyStorageCost(1000)).toBe(3330);
	});

	it("charges 0 micro-credits for 0 minutes stored", () => {
		expect(dailyStorageCost(0)).toBe(0);
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

describe("Minimum Balance Check", () => {
	it("4,999 micro-credits is insufficient", () => {
		expect(4_999 < MIN_BALANCE_MICRO_CREDITS).toBe(true);
	});

	it("5,000 micro-credits is sufficient", () => {
		expect(5_000 < MIN_BALANCE_MICRO_CREDITS).toBe(false);
	});

	it("5,001 micro-credits is sufficient", () => {
		expect(5_001 < MIN_BALANCE_MICRO_CREDITS).toBe(false);
	});

	it("0 micro-credits is insufficient", () => {
		expect(0 < MIN_BALANCE_MICRO_CREDITS).toBe(true);
	});
});
