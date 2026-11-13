import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_credits",
}));

import {
	CREDIT_CHECKOUT_3DS_OVER_CENTS,
	creditCheckoutSessionParams,
	creditPurchaseDescription,
	STRIPE_DESCRIPTION_LIMIT,
} from "@/lib/infra-credit-checkout";
import { parseCreditUsEin } from "@/lib/infra-credit-us-ein";

describe("credit purchase text", () => {
	it("uses the app name as stored, trimmed", () => {
		expect(creditPurchaseDescription("  Course\n site ")).toBe(
			"Cap Infra credits for Course site",
		);
	});

	it("falls back to the plain product name for a blank app name", () => {
		expect(creditPurchaseDescription("   ")).toBe("Cap Infra credits");
	});

	it("caps the description at Stripe's 1,000 characters, like auto top-up", () => {
		const description = creditPurchaseDescription("x".repeat(5_000));
		expect(description.length).toBe(STRIPE_DESCRIPTION_LIMIT);
		expect(description.startsWith("Cap Infra credits for x")).toBe(true);
	});

	it("falls back when there is no name at all", () => {
		expect(creditPurchaseDescription(null)).toBe("Cap Infra credits");
		expect(creditPurchaseDescription(undefined)).toBe("Cap Infra credits");
	});

	it("keeps the credits product so codes still apply", () => {
		const params = creditCheckoutSessionParams({
			customerId: "cus_1",
			accountId: "account-1",
			appName: "Course site",
			amountCents: 1000,
			receiptEmail: "owner@example.com",
		});
		expect(params.line_items[0]?.price_data.product).toBe("prod_credits");
		expect(params.payment_method_types).toEqual(["card"]);
	});
});

describe("3D Secure on large credit purchases", () => {
	const paramsFor = (amountCents: number) =>
		creditCheckoutSessionParams({
			customerId: "cus_1",
			accountId: "account-1",
			appName: "Course site",
			amountCents,
			receiptEmail: "owner@example.com",
		});

	it("offers card only on every credit checkout, whatever the amount", () => {
		for (const amountCents of [500, 5_000, 100_000, 100_001, 1_000_000]) {
			expect(paramsFor(amountCents).payment_method_types).toEqual(["card"]);
		}
	});

	it("sends no card options at exactly $1,000", () => {
		expect(CREDIT_CHECKOUT_3DS_OVER_CENTS).toBe(100_000);
		expect(paramsFor(100_000)).not.toHaveProperty("payment_method_options");
		expect(paramsFor(5_000)).not.toHaveProperty("payment_method_options");
	});

	it("asks for 3D Secure from $1,000.01", () => {
		for (const amountCents of [100_001, 500_000, 1_000_000]) {
			const params = paramsFor(amountCents);
			expect(params.payment_method_types).toEqual(["card"]);
			expect(params.payment_method_options).toEqual({
				card: { request_three_d_secure: "any" },
			});
		}
	});

	it("builds the same session params every time for the same amount, so a retry under one Stripe key matches", () => {
		for (const amountCents of [5_000, 100_000, 100_001, 1_000_000]) {
			const first = paramsFor(amountCents);
			const retry = paramsFor(amountCents);
			expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
		}
	});

	it("changes nothing else about the session", () => {
		const {
			payment_method_options: _options,
			line_items: largeItems,
			...large
		} = paramsFor(100_001);
		const { line_items: smallItems, ...small } = paramsFor(100_000);
		expect(large).toEqual(small);
		expect(largeItems[0]?.price_data.unit_amount).toBe(100_001);
		expect(smallItems[0]?.price_data.unit_amount).toBe(100_000);
	});
});

describe("parseCreditUsEin", () => {
	it("formats nine digits with or without a dash", () => {
		expect(parseCreditUsEin("123456789")).toEqual({
			state: "valid",
			ein: "12-3456789",
		});
		expect(parseCreditUsEin(" 12-3456789 ")).toEqual({
			state: "valid",
			ein: "12-3456789",
		});
	});

	it("treats a missing or blank EIN as none", () => {
		expect(parseCreditUsEin(undefined)).toEqual({ state: "none" });
		expect(parseCreditUsEin("  ")).toEqual({ state: "none" });
	});

	it("refuses anything that is not nine digits", () => {
		expect(parseCreditUsEin("12-345")).toEqual({ state: "invalid" });
		expect(parseCreditUsEin("AB-CDEFGHI")).toEqual({ state: "invalid" });
	});
});
