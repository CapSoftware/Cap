import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));

import { PRO_CREDIT_COVERS } from "@/components/pages/infra/content";
import {
	resolveTopUpAmount,
	TOP_UP_AMOUNT_PLACEHOLDER,
	TOP_UP_MAX_CENTS,
	TOP_UP_MIN_CENTS,
	TOP_UP_RANGE_TEXT,
	topUpButtonLabel,
	topUpCovers,
	topUpCoversText,
} from "@/lib/infra-top-up";

const NOT_AN_AMOUNT = "Enter an amount in dollars, for example 25 or 12.50.";
const OUT_OF_RANGE = "Enter an amount from $5 to $10,000.";
const PRESET = 2_500;

describe("the amount a top-up will charge", () => {
	it.each([
		["abc", NOT_AN_AMOUNT],
		["twenty", NOT_AN_AMOUNT],
		["2o", NOT_AN_AMOUNT],
		["-10", NOT_AN_AMOUNT],
		["12.345", NOT_AN_AMOUNT],
		["4.999", NOT_AN_AMOUNT],
		["1e3", NOT_AN_AMOUNT],
		["5 5", NOT_AN_AMOUNT],
		["$", NOT_AN_AMOUNT],
		[".", NOT_AN_AMOUNT],
		["1,00", NOT_AN_AMOUNT],
		["4.99", OUT_OF_RANGE],
		["0", OUT_OF_RANGE],
		["10000.01", OUT_OF_RANGE],
		["10001", OUT_OF_RANGE],
		["10,000.01", OUT_OF_RANGE],
		["99999999999999999999", OUT_OF_RANGE],
	])(
		"blocks %j with a reason and never falls back to the preset",
		(typed, reason) => {
			expect(resolveTopUpAmount(typed, PRESET)).toEqual({
				amountCents: null,
				error: reason,
				custom: true,
			});
			expect(topUpButtonLabel(resolveTopUpAmount(typed, PRESET))).toBe(
				"Add credits",
			);
		},
	);

	it.each([
		["5", 500, "Add $5"],
		["5.00", 500, "Add $5"],
		["5.", 500, "Add $5"],
		["12.5", 1_250, "Add $12.50"],
		["12.34", 1_234, "Add $12.34"],
		["1000", 100_000, "Add $1,000"],
		["1,000", 100_000, "Add $1,000"],
		["$20", 2_000, "Add $20"],
		[" 25 ", 2_500, "Add $25"],
		["999.99", 99_999, "Add $999.99"],
		["1000.01", 100_001, "Add $1,000.01"],
		["10000", 1_000_000, "Add $10,000"],
		["10,000.00", 1_000_000, "Add $10,000"],
		["9,999.99", 999_999, "Add $9,999.99"],
	])("takes %j as a typed amount", (typed, cents, label) => {
		const amount = resolveTopUpAmount(typed, PRESET);
		expect(amount).toEqual({ amountCents: cents, error: null, custom: true });
		expect(topUpButtonLabel(amount)).toBe(label);
	});

	it("uses the preset only while the field is empty", () => {
		expect(resolveTopUpAmount("", PRESET)).toEqual({
			amountCents: PRESET,
			error: null,
			custom: false,
		});
		expect(resolveTopUpAmount("   ", 10_000)).toEqual({
			amountCents: 10_000,
			error: null,
			custom: false,
		});
		expect(topUpButtonLabel(resolveTopUpAmount("", PRESET))).toBe("Add $25");
	});

	it("has nothing to charge when the field is empty and no preset is chosen", () => {
		const amount = resolveTopUpAmount("", null);
		expect(amount).toEqual({ amountCents: null, error: null, custom: false });
		expect(topUpButtonLabel(amount)).toBe("Add credits");
	});

	it("lets a typed amount win over the preset every time", () => {
		for (const typed of ["abc", "4.99", "5", "1000", "1000.01", "-10"]) {
			const amount = resolveTopUpAmount(typed, PRESET);
			expect(amount.custom).toBe(true);
			if (amount.amountCents !== null) {
				expect(amount.amountCents).toBeGreaterThanOrEqual(TOP_UP_MIN_CENTS);
				expect(amount.amountCents).toBeLessThanOrEqual(TOP_UP_MAX_CENTS);
			}
		}
		expect(resolveTopUpAmount("abc", PRESET).amountCents).not.toBe(PRESET);
		expect(resolveTopUpAmount("-10", PRESET).amountCents).not.toBe(1_000);
	});

	it("keeps the limits the checkout enforces", () => {
		expect(TOP_UP_MIN_CENTS).toBe(500);
		expect(TOP_UP_MAX_CENTS).toBe(1_000_000);
		expect(TOP_UP_RANGE_TEXT).toBe("$5 to $10,000");
		expect(TOP_UP_AMOUNT_PLACEHOLDER).toBe("Other, 5 to 10,000");
	});
});

describe("what a top-up buys", () => {
	it("works $5 out the same way as the landing page", () => {
		const covers = topUpCovers(5);
		expect([covers.storedMinutes, covers.transcribedHours]).toEqual(
			PRO_CREDIT_COVERS.map((cover) => cover.amount),
		);
	});

	it("rounds $25 down like the landing page", () => {
		expect(topUpCovers(25)).toEqual({
			storedMinutes: 29_400,
			transcribedHours: 250,
		});
	});

	it("says what $5 and $25 buy in one line", () => {
		expect(topUpCoversText()).toBe(
			"At 1080p, $5 stores 5,800 minutes for 30 days or transcribes 50 hours. $25 stores 29,400 minutes or transcribes 250 hours.",
		);
	});
});
