import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as startGuestCheckout } from "@/app/api/settings/billing/guest-checkout/route";
import { GET } from "@/app/mobile/checkout/complete/route";
import {
	getCheckoutRedirectUrls,
	getMobileCheckoutDeepLink,
} from "@/lib/mobile-checkout";

const checkoutMocks = vi.hoisted(() => ({
	create: vi.fn(),
	track: vi.fn(() => Promise.resolve()),
	rateLimited: vi.fn(() => Promise.resolve(false)),
	listPromotionCodes: vi.fn(),
}));

// Matches STRIPE_PLAN_IDS.development, which is what the allowlist resolves to
// when VERCEL_ENV is unset (as it is under test).
const DEV_MONTHLY = "price_1P9C1DFJxA1XpeSsTwwuddnq";
const DEV_YEARLY = "price_1Q3esrFJxA1XpeSsFwp486RN";

vi.mock("@cap/env", () => ({
	buildEnv: {},
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));

vi.mock("@cap/utils", () => ({
	stripe: () => ({
		checkout: {
			sessions: { create: checkoutMocks.create },
		},
		promotionCodes: { list: checkoutMocks.listPromotionCodes },
	}),
	STRIPE_PLAN_IDS: {
		development: {
			yearly: "price_1Q3esrFJxA1XpeSsFwp486RN",
			monthly: "price_1P9C1DFJxA1XpeSsTwwuddnq",
		},
		production: {
			yearly: "price_1S2al7FJxA1XpeSsJCI5Z2UD",
			monthly: "price_1S2akxFJxA1XpeSsfoAUUbpJ",
		},
	},
}));

vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: checkoutMocks.rateLimited,
	RATE_LIMIT_IDS: { GUEST_CHECKOUT: "rl_guest_checkout" },
}));

vi.mock("@/lib/server-analytics", () => ({
	trackServerEvent: checkoutMocks.track,
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
		checkoutMocks.rateLimited.mockResolvedValue(false);
		checkoutMocks.listPromotionCodes.mockResolvedValue({
			data: [{ id: "promo_migrate20" }],
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
			makeGuestCheckoutRequest({ priceId: DEV_MONTHLY, quantity: 1 }),
		);

		expect(response.status).toBe(200);
		expect(checkoutMocks.create).toHaveBeenCalledWith({
			line_items: [{ price: DEV_MONTHLY, quantity: 1 }],
			mode: "subscription",
			success_url:
				"https://cap.so/dashboard/caps?upgrade=true&guest=true&session_id={CHECKOUT_SESSION_ID}",
			cancel_url: "https://cap.so/pricing",
			allow_promotion_codes: true,
			after_expiration: {
				recovery: { enabled: true, allow_promotion_codes: true },
			},
			metadata: {
				platform: "web",
				guestCheckout: "true",
				priceId: DEV_MONTHLY,
			},
		});
	});

	it("refuses price ids the pricing page does not offer", async () => {
		// The account still carries retired cheaper plans (legacy $9/mo, $72/yr);
		// an unauthenticated caller must not be able to subscribe at one.
		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({
				priceId: "price_1Q29mcFJxA1XpeSsbti0xJpZ",
				quantity: 1,
			}),
		);

		expect(response.status).toBe(400);
		expect(checkoutMocks.create).not.toHaveBeenCalled();
	});

	it("rejects quantities outside the supported seat range", async () => {
		for (const quantity of [0, -1, 101, 2.5]) {
			const response = await startGuestCheckout(
				makeGuestCheckoutRequest({ priceId: DEV_MONTHLY, quantity }),
			);

			expect(response.status).toBe(400);
		}

		expect(checkoutMocks.create).not.toHaveBeenCalled();
	});

	it("defaults a missing quantity to a single seat", async () => {
		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({ priceId: DEV_MONTHLY }),
		);

		expect(response.status).toBe(200);
		expect(checkoutMocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				line_items: [{ price: DEV_MONTHLY, quantity: 1 }],
			}),
		);
	});

	it("stops minting Stripe sessions once the caller is rate limited", async () => {
		checkoutMocks.rateLimited.mockResolvedValue(true);

		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({ priceId: DEV_MONTHLY, quantity: 1 }),
		);

		expect(response.status).toBe(429);
		expect(checkoutMocks.create).not.toHaveBeenCalled();
	});

	it("applies an allowlisted campaign code from the URL", async () => {
		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({
				priceId: DEV_MONTHLY,
				quantity: 1,
				promoCode: "MIGRATE20",
			}),
		);

		expect(response.status).toBe(200);
		expect(checkoutMocks.listPromotionCodes).toHaveBeenCalledWith({
			code: "MIGRATE20",
			active: true,
			limit: 1,
		});
		const params = checkoutMocks.create.mock.calls[0]?.[0];
		expect(params.discounts).toEqual([{ promotion_code: "promo_migrate20" }]);
		// Stripe rejects discounts and allow_promotion_codes together.
		expect(params.allow_promotion_codes).toBeUndefined();
	});

	it("ignores promo codes that are not on the allowlist", async () => {
		// The account carries active unrestricted 100%-off codes, so honouring an
		// arbitrary ?promo= would hand out free Cap Pro.
		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({
				priceId: DEV_MONTHLY,
				quantity: 1,
				promoCode: "RICHIEGIFT",
			}),
		);

		expect(response.status).toBe(200);
		expect(checkoutMocks.listPromotionCodes).not.toHaveBeenCalled();
		const params = checkoutMocks.create.mock.calls[0]?.[0];
		expect(params.discounts).toBeUndefined();
		expect(params.allow_promotion_codes).toBe(true);
	});

	it("falls back to manual entry when the campaign code is no longer active", async () => {
		checkoutMocks.listPromotionCodes.mockResolvedValue({ data: [] });

		const response = await startGuestCheckout(
			makeGuestCheckoutRequest({
				priceId: DEV_MONTHLY,
				quantity: 1,
				promoCode: "migrate20",
			}),
		);

		expect(response.status).toBe(200);
		const params = checkoutMocks.create.mock.calls[0]?.[0];
		expect(params.discounts).toBeUndefined();
		expect(params.allow_promotion_codes).toBe(true);
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
				priceId: DEV_YEARLY,
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
					priceId: DEV_YEARLY,
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
