import { describe, expect, it } from "vitest";
import { homepageCopy } from "@/data/homepage-copy";
import { PRICING } from "@/data/pricing";

describe("PRICING", () => {
	it("matches the published parity price points", () => {
		expect(PRICING.pro.monthly).toBe(12);
		expect(PRICING.pro.yearlyTotal).toBe(98);
		expect(PRICING.commercial.yearly).toBe(29);
		expect(PRICING.commercial.lifetime).toBe(58);
	});

	it("derives the annual per-month figure from the yearly total", () => {
		const truncatedToCents =
			Math.floor((PRICING.pro.yearlyTotal / 12) * 100) / 100;
		expect(PRICING.pro.annualPerMonth).toBe(truncatedToCents);
	});

	it("is the source homepage copy pulls its numbers from", () => {
		expect(homepageCopy.pricing.pro.pricing.monthly).toBe(PRICING.pro.monthly);
		expect(homepageCopy.pricing.pro.pricing.annual).toBe(
			PRICING.pro.annualPerMonth,
		);
		expect(homepageCopy.pricing.commercial.pricing.yearly).toBe(
			PRICING.commercial.yearly,
		);
		expect(homepageCopy.pricing.commercial.pricing.lifetime).toBe(
			PRICING.commercial.lifetime,
		);
	});
});
