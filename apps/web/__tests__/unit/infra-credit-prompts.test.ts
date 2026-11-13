import { describe, expect, it } from "vitest";
import {
	firstCreditOffersAddCredits,
	lowBalanceText,
} from "@/lib/infra-credit-prompts";

const storing = {
	hasAccount: true,
	standing: "active" as const,
	monthlyStorageMicroCredits: 300_000,
	balanceMicroCredits: 40_000,
	requiredMicroCredits: 70_000,
	shortfallMicroCredits: 30_000,
};

describe("lowBalanceText", () => {
	it("warns when the balance no longer covers the next upload", () => {
		expect(lowBalanceText(storing)).toBe(
			"Credit is low. Uploading needs at least $0.70 and this app has $0.40.",
		);
	});

	it("stays quiet while the balance covers the next upload", () => {
		expect(
			lowBalanceText({
				...storing,
				balanceMicroCredits: 70_000,
				shortfallMicroCredits: 0,
			}),
		).toBeNull();
	});

	const storingNothing = {
		...storing,
		monthlyStorageMicroCredits: 0,
		requiredMicroCredits: 1,
		shortfallMicroCredits: 0,
	};

	it("warns an app that stores nothing when it has under $1", () => {
		expect(
			lowBalanceText({ ...storingNothing, balanceMicroCredits: 967 }),
		).toBe("Credit is low. This app has $0.00967, under $1.00.");
		expect(
			lowBalanceText({ ...storingNothing, balanceMicroCredits: 99_999 }),
		).toBe("Credit is low. This app has $0.99999, under $1.00.");
	});

	it("stays quiet for an app that stores nothing once it has $1 or more", () => {
		expect(
			lowBalanceText({ ...storingNothing, balanceMicroCredits: 100_000 }),
		).toBeNull();
		expect(
			lowBalanceText({ ...storingNothing, balanceMicroCredits: 2_500_000 }),
		).toBeNull();
	});

	it("leaves an unfunded app to the Add credits prompt instead of both", () => {
		const unfunded = { ...storingNothing, balanceMicroCredits: 0 };
		expect(lowBalanceText(unfunded)).toBeNull();
		expect(
			firstCreditOffersAddCredits({
				balanceMicroCredits: 0,
				proCreditStatus: "claimed",
			}),
		).toBe(true);
	});

	it("keeps the floor to active, funded apps", () => {
		const low = { ...storingNothing, balanceMicroCredits: 967 };
		expect(lowBalanceText({ ...low, standing: "grace" })).toBeNull();
		expect(lowBalanceText({ ...low, hasAccount: false })).toBeNull();
	});

	it("leaves grace and paused apps to the out of credit notice", () => {
		expect(lowBalanceText({ ...storing, standing: "grace" })).toBeNull();
		expect(lowBalanceText({ ...storing, standing: "paused" })).toBeNull();
	});

	it("says nothing without a credit account", () => {
		expect(lowBalanceText({ ...storing, hasAccount: false })).toBeNull();
	});
});

describe("firstCreditOffersAddCredits", () => {
	it("is true for an unfunded app when there is no Cap Pro credit to claim", () => {
		for (const status of ["claimed", "trial", "not_pro"]) {
			expect(
				firstCreditOffersAddCredits({
					balanceMicroCredits: 0,
					proCreditStatus: status,
				}),
			).toBe(true);
		}
	});

	it("is false once the app has credit or can claim Cap Pro credit", () => {
		expect(
			firstCreditOffersAddCredits({
				balanceMicroCredits: 1,
				proCreditStatus: "claimed",
			}),
		).toBe(false);
		expect(
			firstCreditOffersAddCredits({
				balanceMicroCredits: 0,
				proCreditStatus: "available",
			}),
		).toBe(false);
	});
});
