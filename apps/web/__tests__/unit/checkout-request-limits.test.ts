import { STRIPE_PLAN_IDS } from "@cap/utils";
import { Hono } from "hono";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	listCustomers: vi.fn(),
	getCurrentUser: vi.fn(),
	referralDiscountForCheckout: vi.fn(),
	isRateLimited: vi.fn(),
	env: { WEB_URL: "https://cap.so" } as Record<string, string | undefined>,
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({
			set: () => ({ where: async () => undefined }),
		}),
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));

vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));

vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/feedback", () => ({ Feedback: vi.fn() }));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
		NEXT_PUBLIC_IS_CAP: "true",
	},
}));

vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return {
		...actual,
		STRIPE_AVAILABLE: () => true,
		stripe: () => ({
			customers: {
				list: mocks.listCustomers,
				create: vi.fn(async () => ({ id: "cus_new" })),
				update: vi.fn(async () => ({ id: "cus_new" })),
			},
			checkout: { sessions: { create: mocks.createSession } },
		}),
		userIsPro: () => false,
	};
});

vi.mock("@cap/web-backend", () => ({ ImageUploads: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));

vi.mock("@/lib/checkout/referral", () => ({
	createWithReferralDiscount: (
		discount: unknown,
		create: (discount: unknown) => unknown,
	) => create(discount),
	guestReferralParams: () => ({}),
	referralDiscountForCheckout: mocks.referralDiscountForCheckout,
	referralDiscountMetadata: () => ({}),
	referralDiscountParams: () => ({ allow_promotion_codes: true }),
}));

vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: {
		CHECKOUT: "rl_checkout",
		GUEST_CHECKOUT: "rl_guest_checkout",
	},
	isRateLimited: mocks.isRateLimited,
}));

const { POST: startGuestCheckout } = await import(
	"@/app/api/settings/billing/guest-checkout/route"
);
const { POST: subscribe } = await import(
	"@/app/api/settings/billing/subscribe/route"
);
const { corsMiddleware } = await import("@/app/api/utils");
const root = await import("@/app/api/desktop/[...route]/root");

const desktop = new Hono()
	.basePath("/api/desktop")
	.use(corsMiddleware)
	.route("/", root.app);

const priceId = STRIPE_PLAN_IDS.development.monthly;

const post = (path: string, body: Record<string, unknown>) =>
	new NextRequest(`https://cap.so${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-real-ip": "203.0.113.9" },
		body: JSON.stringify(body),
	});

const desktopSubscribe = () =>
	desktop.request("https://cap.so/api/desktop/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ priceId }),
	});

describe("checkout request limits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.env = { WEB_URL: "https://cap.so" };
		mocks.isRateLimited.mockResolvedValue(false);
		mocks.referralDiscountForCheckout.mockResolvedValue(null);
		mocks.listCustomers.mockResolvedValue({ data: [] });
		mocks.getCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "person@example.com",
			name: null,
			image: null,
			stripeCustomerId: "cus_1",
			stripeSubscriptionStatus: null,
			thirdPartyStripeSubscriptionId: null,
		});
		mocks.createSession.mockResolvedValue({
			id: "cs_1",
			url: "https://checkout.stripe.com/c/pay/cs_1",
		});
	});

	describe("POST /api/settings/billing/guest-checkout", () => {
		it("returns 429 per address before creating a session", async () => {
			mocks.isRateLimited.mockResolvedValue(true);

			const response = await startGuestCheckout(
				post("/api/settings/billing/guest-checkout", {
					priceId,
					quantity: 1,
					hosted: true,
				}),
			);

			expect(response.status).toBe(429);
			expect(mocks.isRateLimited).toHaveBeenCalledWith("rl_guest_checkout", {
				headers: expect.any(Headers),
			});
			const [, options] = mocks.isRateLimited.mock.calls[0] ?? [];
			expect(options.headers.get("x-real-ip")).toBe("203.0.113.9");
			expect(mocks.createSession).not.toHaveBeenCalled();
		});

		it("still opens a session under the limit", async () => {
			const response = await startGuestCheckout(
				post("/api/settings/billing/guest-checkout", {
					priceId,
					quantity: 1,
					hosted: true,
				}),
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				url: "https://checkout.stripe.com/c/pay/cs_1",
			});
			expect(mocks.createSession).toHaveBeenCalledTimes(1);
		});

		it("rejects an invalid price before counting against the limit", async () => {
			const response = await startGuestCheckout(
				post("/api/settings/billing/guest-checkout", {
					priceId: "price_unknown",
					quantity: 1,
				}),
			);

			expect(response.status).toBe(400);
			expect(mocks.isRateLimited).not.toHaveBeenCalled();
		});
	});

	describe("POST /api/settings/billing/subscribe", () => {
		it("returns 429 per account before reaching Stripe or Dub", async () => {
			mocks.isRateLimited.mockResolvedValue(true);

			const response = await subscribe(
				post("/api/settings/billing/subscribe", { priceId, quantity: 1 }),
			);

			expect(response.status).toBe(429);
			expect(mocks.isRateLimited).toHaveBeenCalledWith("rl_checkout", {
				key: "checkout:user-1",
			});
			expect(mocks.referralDiscountForCheckout).not.toHaveBeenCalled();
			expect(mocks.createSession).not.toHaveBeenCalled();
		});

		it("still opens a session under the limit", async () => {
			const response = await subscribe(
				post("/api/settings/billing/subscribe", { priceId, quantity: 1 }),
			);

			expect(response.status).toBe(200);
			expect(mocks.createSession).toHaveBeenCalledTimes(1);
		});
	});

	describe("POST /api/desktop/subscribe", () => {
		it("returns 429 per account before reaching Stripe or Dub", async () => {
			mocks.isRateLimited.mockResolvedValue(true);

			const response = await desktopSubscribe();

			expect(response.status).toBe(429);
			expect(mocks.isRateLimited).toHaveBeenCalledWith("rl_checkout", {
				key: "checkout:user-1",
				headers: expect.any(Headers),
			});
			expect(mocks.referralDiscountForCheckout).not.toHaveBeenCalled();
			expect(mocks.createSession).not.toHaveBeenCalled();
		});

		it("still opens a session under the limit", async () => {
			const response = await desktopSubscribe();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				url: "https://checkout.stripe.com/c/pay/cs_1",
			});
		});
	});
});
