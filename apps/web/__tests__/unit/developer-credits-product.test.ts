import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ VERCEL_ENV: undefined as string | undefined }));

vi.mock("@cap/env", () => ({ serverEnv: () => env }));
vi.mock("@cap/utils", () => ({
	STRIPE_DEVELOPER_CREDITS_PRODUCT_ID: {
		development: "prod_test_mode",
		production: "prod_live_mode",
	},
}));

import { developerCreditsProductId } from "@/lib/developer-credits-product";

describe("credit product for the deployment", () => {
	it("uses the live product only on the production deployment", () => {
		env.VERCEL_ENV = "production";
		expect(developerCreditsProductId()).toBe("prod_live_mode");
	});

	it("uses the test product everywhere else", () => {
		for (const value of ["preview", "development", "", undefined]) {
			env.VERCEL_ENV = value;
			expect(developerCreditsProductId()).toBe("prod_test_mode");
		}
	});
});
