import { describe, expect, it } from "vitest";
import { checkoutPath, parsePromotionCode } from "@/lib/checkout/plans";

describe("checkout promotion codes", () => {
	it("keeps a plain code, trimmed and upper-cased", () => {
		expect(parsePromotionCode("BLACKFRIDAY")).toBe("BLACKFRIDAY");
		expect(parsePromotionCode(" blackfriday ")).toBe("BLACKFRIDAY");
		expect(parsePromotionCode("SPRING_25-off")).toBe("SPRING_25-OFF");
	});

	it("drops anything that is not a plain code", () => {
		expect(parsePromotionCode(undefined)).toBeNull();
		expect(parsePromotionCode("")).toBeNull();
		expect(parsePromotionCode("A")).toBeNull();
		expect(parsePromotionCode("BLACK FRIDAY")).toBeNull();
		expect(parsePromotionCode("<script>")).toBeNull();
		expect(parsePromotionCode("-LEADING")).toBeNull();
		expect(parsePromotionCode("X".repeat(41))).toBeNull();
		expect(parsePromotionCode(["BLACKFRIDAY"])).toBeNull();
	});

	it("carries a valid code in the checkout path and leaves it out otherwise", () => {
		expect(
			checkoutPath({ plan: "yearly", seats: 1, promo: "blackfriday" }),
		).toBe("/checkout?plan=yearly&seats=1&promo=BLACKFRIDAY");
		expect(checkoutPath({ plan: "yearly", seats: 3 })).toBe(
			"/checkout?plan=yearly&seats=3",
		);
		expect(
			checkoutPath({ plan: "monthly", seats: 1, promo: "no spaces" }),
		).toBe("/checkout?plan=monthly&seats=1");
	});
});
