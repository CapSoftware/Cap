import { describe, expect, it } from "vitest";
import { resolveCheckoutReturnUrls } from "@/lib/checkout-return";

describe("resolveCheckoutReturnUrls", () => {
	it("returns null without a return path", () => {
		expect(resolveCheckoutReturnUrls("https://cap.so", undefined)).toBeNull();
		expect(resolveCheckoutReturnUrls("https://cap.so", "")).toBeNull();
		expect(resolveCheckoutReturnUrls("https://cap.so", 42)).toBeNull();
	});

	it("comes back to the same page after checkout", () => {
		expect(
			resolveCheckoutReturnUrls(
				"https://cap.so/",
				"/onboarding/loom?url=https%3A%2F%2Fwww.loom.com%2Fshare%2Fabc",
			),
		).toEqual({
			successUrl:
				"https://cap.so/onboarding/loom?url=https%3A%2F%2Fwww.loom.com%2Fshare%2Fabc&upgrade=true&session_id={CHECKOUT_SESSION_ID}",
			cancelUrl:
				"https://cap.so/onboarding/loom?url=https%3A%2F%2Fwww.loom.com%2Fshare%2Fabc",
		});
		expect(
			resolveCheckoutReturnUrls("https://cap.so", "/onboarding/upload#drop"),
		).toEqual({
			successUrl:
				"https://cap.so/onboarding/upload?upgrade=true&session_id={CHECKOUT_SESSION_ID}#drop",
			cancelUrl: "https://cap.so/onboarding/upload#drop",
		});
	});

	it("never leaves the app", () => {
		expect(
			resolveCheckoutReturnUrls("https://cap.so", "https://evil.example/x"),
		).toEqual({
			successUrl:
				"https://cap.so/dashboard?upgrade=true&session_id={CHECKOUT_SESSION_ID}",
			cancelUrl: "https://cap.so/dashboard",
		});
		expect(
			resolveCheckoutReturnUrls("https://cap.so", "//evil.example/x"),
		).toEqual({
			successUrl:
				"https://cap.so/dashboard?upgrade=true&session_id={CHECKOUT_SESSION_ID}",
			cancelUrl: "https://cap.so/dashboard",
		});
	});
});
