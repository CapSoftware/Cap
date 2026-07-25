import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as startGuestCheckout } from "@/app/api/settings/billing/guest-checkout/route";
import { GET } from "@/app/mobile/checkout/complete/route";
import {
	getCheckoutRedirectUrls,
	getMobileCheckoutDeepLink,
} from "@/lib/mobile-checkout";

const checkoutMocks = vi.hoisted(() => ({
	capture: vi.fn(),
	create: vi.fn(),
	shutdown: vi.fn(() => Promise.resolve()),
}));

vi.mock("@cap/env", () => ({
	buildEnv: {
		NEXT_PUBLIC_POSTHOG_HOST: "https://posthog.test",
		NEXT_PUBLIC_POSTHOG_KEY: "test-key",
	},
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));

vi.mock("@cap/utils", () => ({
	stripe: () => ({
		checkout: {
			sessions: { create: checkoutMocks.create },
		},
	}),
}));

vi.mock("posthog-node", () => ({
	PostHog: class {
		capture = checkoutMocks.capture;
		shutdown = checkoutMocks.shutdown;
	},
}));

const makeGuestCheckoutRequest = (body: Record<string, unknown>) =>
	new Request("https://cap.so/api/settings/billing/guest-checkout", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as import("next/server").NextRequest;

describe("checkout redirects", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		checkoutMocks.create.mockResolvedValue({
			id: "cs_test",
			url: "https://pay.cap.so/session",
		});
	});

	it("preserves the existing desktop checkout redirects", () => {
		expect(getCheckoutRedirectUrls("desktop", "https://cap.so")).toEqual({
			successUrl: "https://cap.so/dashboard/caps?upgrade=true",
			cancelUrl: "https://cap.so/pricing",
		});
	});

	it("preserves the existing web guest checkout redirects", () => {
		expect(getCheckoutRedirectUrls("web", "https://cap.so")).toEqual({
			successUrl:
				"https://cap.so/dashboard/caps?upgrade=true&guest=true&session_id={CHECKOUT_SESSION_ID}",
			cancelUrl: "https://cap.so/pricing",
		});
	});

	it("keeps existing guest checkout requests on the web flow", async () => {
		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({ priceId: "price_pro", quantity: 1 }),
		);

		expect(response.status).toBe(200);
		expect(checkoutMocks.create).toHaveBeenCalledWith({
			line_items: [{ price: "price_pro", quantity: 1 }],
			mode: "subscription",
			success_url:
				"https://cap.so/dashboard/caps?upgrade=true&guest=true&session_id={CHECKOUT_SESSION_ID}",
			cancel_url: "https://cap.so/pricing",
			allow_promotion_codes: true,
			metadata: {
				platform: "web",
				guestCheckout: "true",
			},
		});
	});

	it("sends mobile checkout results through the HTTPS completion route", () => {
		expect(getCheckoutRedirectUrls("mobile", "https://cap.so/")).toEqual({
			successUrl: "https://cap.so/mobile/checkout/complete?checkout=success",
			cancelUrl: "https://cap.so/mobile/checkout/complete?checkout=cancelled",
		});
	});

	it("uses the app return only when guest checkout is explicitly mobile", async () => {
		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({
				priceId: "price_pro",
				quantity: 1,
				platform: "mobile",
			}),
		);

		expect(response.status).toBe(200);
		expect(checkoutMocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				success_url: "https://cap.so/mobile/checkout/complete?checkout=success",
				cancel_url:
					"https://cap.so/mobile/checkout/complete?checkout=cancelled",
				metadata: {
					platform: "mobile",
					guestCheckout: "true",
				},
			}),
		);
	});

	it("redirects successful mobile checkout back to the Cap app", () => {
		const response = GET(
			new Request("https://cap.so/mobile/checkout/complete?checkout=success"),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			getMobileCheckoutDeepLink("success"),
		);
	});

	it("treats missing or unknown results as cancellation", () => {
		for (const checkout of ["", "?checkout=unknown"]) {
			const response = GET(
				new Request(`https://cap.so/mobile/checkout/complete${checkout}`),
			);

			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe(
				getMobileCheckoutDeepLink("cancelled"),
			);
		}
	});
});
