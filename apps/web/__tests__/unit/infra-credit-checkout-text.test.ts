import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_credits",
}));

import {
	CREDIT_APP_NAME_MAX_LENGTH,
	creditAppName,
	creditCheckoutSessionParams,
	creditPurchaseDescription,
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

	it("limits a long name without splitting a character", () => {
		const name = `${"a".repeat(CREDIT_APP_NAME_MAX_LENGTH - 1)}🎬🎬`;
		const limited = creditAppName(name);
		expect(Array.from(limited)).toHaveLength(CREDIT_APP_NAME_MAX_LENGTH);
		expect(limited.endsWith("🎬")).toBe(true);
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
		expect(params.payment_method_types).toEqual(["card", "link"]);
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
