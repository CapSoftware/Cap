import { STRIPE_PLAN_IDS } from "@cap/utils";
import { describe, expect, it } from "vitest";
import {
	checkoutPath,
	parseCheckoutSeats,
	pickCheckoutCurrency,
	planForPriceId,
	planPriceId,
	sessionIdFromClientSecret,
} from "@/lib/checkout/plans";

describe("checkout plans", () => {
	it("maps plans to the deployment's price ids and back", () => {
		expect(planPriceId("yearly", "production")).toBe(
			STRIPE_PLAN_IDS.production.yearly,
		);
		expect(
			planForPriceId(STRIPE_PLAN_IDS.development.monthly, "development"),
		).toBe("monthly");
		expect(
			planForPriceId(STRIPE_PLAN_IDS.development.monthly, "production"),
		).toBe(null);
		expect(planForPriceId("price_unknown", "production")).toBe(null);
		expect(planForPriceId(undefined, "production")).toBe(null);
	});

	it("falls back to one seat for anything that is not a sane integer", () => {
		expect(parseCheckoutSeats("4")).toBe(4);
		expect(parseCheckoutSeats(7)).toBe(7);
		for (const value of [
			"0",
			"-2",
			"1.5",
			"abc",
			"",
			"10001",
			undefined,
			null,
		]) {
			expect(parseCheckoutSeats(value)).toBe(1);
		}
	});

	it("builds checkout links that keep onboarding only when asked", () => {
		expect(checkoutPath({ plan: "monthly", seats: 2 })).toBe(
			"/checkout?plan=monthly&seats=2",
		);
		expect(checkoutPath({ plan: "yearly", seats: 1, onboarding: true })).toBe(
			"/checkout?plan=yearly&seats=1&onboarding=1",
		);
	});

	it("only presents a local currency every plan price supports", () => {
		const both = new Set(["usd", "gbp", "eur"]);
		const usdOnly = new Set(["usd"]);
		expect(pickCheckoutCurrency("gbp", [both, both])).toBe("gbp");
		expect(pickCheckoutCurrency("eur", [both, usdOnly])).toBe("usd");
		expect(pickCheckoutCurrency("usd", [usdOnly, usdOnly])).toBe("usd");
	});

	it("extracts the session id from a client secret and rejects anything else", () => {
		expect(sessionIdFromClientSecret("cs_test_a1B2c3_secret_xyz")).toBe(
			"cs_test_a1B2c3",
		);
		expect(sessionIdFromClientSecret("cs_test_a1B2c3")).toBe(null);
		expect(sessionIdFromClientSecret("pi_123_secret_abc")).toBe(null);
		expect(sessionIdFromClientSecret("_secret_abc")).toBe(null);
	});
});
