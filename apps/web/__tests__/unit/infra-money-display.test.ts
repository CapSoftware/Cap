import { describe, expect, it } from "vitest";
import {
	creditDollars,
	formatCharge,
	formatCredits,
	formatNeed,
	signedCreditDollars,
} from "@/lib/infra-usage";

describe("what an app has", () => {
	it.each([
		[2_999_901, "$29.99901"],
		[3_000_000, "$30.00"],
		[967, "$0.00967"],
		[1_000, "$0.01"],
		[999, "$0.00999"],
		[1, "$0.00001"],
		[0, "$0.00"],
		[2_499_967, "$24.99967"],
		[1_234_567_800, "$12,345.67800"],
		[123_456_789_000, "$1,234,567.89"],
		[500_000, "$5.00"],
		[510_000, "$5.10"],
	])("shows %i micro-credits as %s", (microCredits, shown) => {
		expect(formatCredits(microCredits)).toBe(shown);
	});

	it("never shows more than is there", () => {
		expect(formatCredits(2_999_901)).not.toBe("$30.00");
		expect(formatCredits(967)).not.toBe("$0.01");
		expect(formatCredits(999.9)).toBe("$0.00999");
		expect(formatCredits(0.9)).toBe("$0.00");
		for (const microCredits of [1, 33, 499, 500, 967, 999, 2_999_901]) {
			const shown = Number(formatCredits(microCredits).replace(/[$,]/g, ""));
			expect(Math.round(shown * 100_000)).toBeLessThanOrEqual(microCredits);
		}
	});

	it("never renders a negative balance or a negative zero", () => {
		expect(formatCredits(-1)).toBe("$0.00");
		expect(formatCredits(-250_000)).toBe("$0.00");
		expect(formatCredits(-0)).toBe("$0.00");
		expect(formatCredits(Number.NaN)).toBe("$0.00");
		expect(formatCharge(-0)).toBe("$0.00");
		for (const value of [-1, -0, -0.4, -250_000, Number.NaN]) {
			expect(formatCredits(value)).not.toContain("-");
			expect(formatNeed(value)).not.toContain("-");
			expect(formatCharge(value)).not.toContain("-");
		}
	});
});

describe("what an app needs", () => {
	it.each([
		[1_000, "$0.01"],
		[33, "$0.00033"],
		[1_091, "$0.01091"],
		[124, "$0.00124"],
		[40_000, "$0.40"],
		[0, "$0.00"],
	])("shows a need of %i micro-credits as %s", (microCredits, shown) => {
		expect(formatNeed(microCredits)).toBe(shown);
	});

	it("rounds a fractional need up, never down", () => {
		expect(formatNeed(1735.4)).toBe("$0.01736");
		expect(formatNeed(0.2)).toBe("$0.00001");
	});

	it.each([
		[967, 1_000],
		[0, 1],
		[999, 1_000],
		[2_999_901, 3_000_000],
		[967, 1_091],
	])(
		"never shows a need the shown balance of %i appears to meet",
		(balance, need) => {
			const shownBalance = formatCredits(balance);
			const shownNeed = formatNeed(need);
			const shownShortfall = formatNeed(need - balance);
			const value = (text: string) =>
				Math.round(Number(text.replace(/[$,]/g, "")) * 100_000);

			expect(shownNeed).not.toBe(shownBalance);
			expect(value(shownBalance)).toBeLessThan(value(shownNeed));
			expect(value(shownBalance) + value(shownShortfall)).toBe(
				value(shownNeed),
			);
		},
	);
});

describe("amounts in a ledger", () => {
	it("shows each amount to the micro-credit it was charged at", () => {
		expect(formatCharge(-33)).toBe("$0.00033");
		expect(formatCharge(2_500_000)).toBe("$25.00");
		expect(formatCharge(1_234)).toBe("$0.01234");
		expect(formatCharge(60)).toBe("$0.00060");
		expect(formatCharge(0)).toBe("$0.00");
	});

	it("lets a row's amount and the running balance add up by eye", () => {
		const rows = [
			{ amount: 2_500_000, balance: 2_500_000 },
			{ amount: -33, balance: 2_499_967 },
			{ amount: -33, balance: 2_499_934 },
			{ amount: 500_000, balance: 2_999_934 },
			{ amount: -33, balance: 2_999_901 },
		];

		expect(rows.map((row) => formatCredits(row.balance))).toEqual([
			"$25.00",
			"$24.99967",
			"$24.99934",
			"$29.99934",
			"$29.99901",
		]);

		const value = (text: string) =>
			Math.round(Number(text.replace(/[$,]/g, "")) * 100_000);
		let running = 0;
		for (const row of rows) {
			running += Math.sign(row.amount) * value(formatCharge(row.amount));
			expect(value(formatCredits(row.balance))).toBe(running);
		}
	});

	it("keeps an estimate under one micro-credit from reading as free", () => {
		expect(formatCharge(0.2)).toBe("<$0.00001");
		expect(formatCharge(44.48)).toBe("$0.00044");
	});
});

describe("dollars in API responses", () => {
	it("writes a balance exactly, with no thousands separators", () => {
		expect(creditDollars(2_999_901)).toBe("29.99901");
		expect(creditDollars(967)).toBe("0.00967");
		expect(creditDollars(500_000)).toBe("5.00");
		expect(creditDollars(123_456_700_000)).toBe("1234567.00");
		expect(creditDollars(-5)).toBe("0.00");
	});

	it("signs a ledger amount and never signs zero", () => {
		expect(signedCreditDollars(-33)).toBe("-0.00033");
		expect(signedCreditDollars(2_500_000)).toBe("25.00");
		expect(signedCreditDollars(0)).toBe("0.00");
		expect(signedCreditDollars(-0)).toBe("0.00");
	});
});
