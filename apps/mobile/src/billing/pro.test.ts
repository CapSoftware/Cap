import { describe, expect, it } from "vitest";
import { getProPlan, MobileBillingError } from "./pro";

describe("mobile Pro plan", () => {
	it("loads the signed-in account plan", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					upgraded: true,
					stripeSubscriptionStatus: "active",
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			await expect(
				getProPlan({ apiKey: "mobile-key", baseUrl: "https://cap.so/" }),
			).resolves.toEqual({
				upgraded: true,
				stripeSubscriptionStatus: "active",
			});
			expect(String(calls[0]?.input)).toBe("https://cap.so/api/desktop/plan");
			expect(calls[0]?.init?.headers).toEqual({
				Authorization: "Bearer mobile-key",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("preserves error response details", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ code: "billing_unavailable" }), {
				status: 503,
			})) as typeof fetch;

		try {
			await expect(
				getProPlan({ apiKey: "mobile-key", baseUrl: "https://cap.so" }),
			).rejects.toMatchObject({
				status: 503,
				payload: { code: "billing_unavailable" },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects invalid plan responses", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ upgraded: "yes" }), {
				status: 200,
			})) as typeof fetch;

		try {
			await expect(
				getProPlan({ apiKey: "mobile-key", baseUrl: "https://cap.so" }),
			).rejects.toBeInstanceOf(MobileBillingError);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
