import { STRIPE_PLAN_IDS } from "@cap/utils";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	listSubscriptions: vi.fn(),
	getCurrentUser: vi.fn(),
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
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));

vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return {
		...actual,
		STRIPE_AVAILABLE: () => true,
		stripe: () => ({
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
	referralDiscountForCheckout: vi.fn(async () => null),
	referralDiscountMetadata: () => ({}),
	referralDiscountParams: () => ({ allow_promotion_codes: true }),
}));

vi.mock("@/lib/checkout/stripe", () => ({
	checkoutStripe: () => ({
		subscriptions: { list: mocks.listSubscriptions },
	}),
}));

vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: {},
	isRateLimited: vi.fn(async () => false),
}));

const { corsMiddleware } = await import("@/app/api/utils");
const root = await import("@/app/api/desktop/[...route]/root");

const app = new Hono()
	.basePath("/api/desktop")
	.use(corsMiddleware)
	.route("/", root.app);

const subscribe = () =>
	app.request("https://cap.so/api/desktop/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ priceId: STRIPE_PLAN_IDS.development.monthly }),
	});

describe("POST /api/desktop/subscribe", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "person@example.com",
			stripeCustomerId: "cus_1",
			stripeSubscriptionStatus: null,
			thirdPartyStripeSubscriptionId: null,
		});
		mocks.listSubscriptions.mockResolvedValue({ data: [] });
		mocks.createSession.mockResolvedValue({
			id: "cs_desktop",
			url: "https://checkout.stripe.com/c/pay/cs_desktop",
		});
	});

	it.each(["active", "trialing", "past_due"])(
		"does not open a checkout when Stripe shows a %s Pro subscription the account has not recorded",
		async (status) => {
			mocks.listSubscriptions.mockResolvedValue({
				data: [{ id: "sub_live", status, metadata: {} }],
			});

			const response = await subscribe();

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: true,
				subscription: true,
			});
			expect(mocks.listSubscriptions).toHaveBeenCalledWith({
				customer: "cus_1",
				limit: 100,
			});
			expect(mocks.createSession).not.toHaveBeenCalled();
		},
	);

	it("opens a checkout when the customer's earlier subscriptions have ended", async () => {
		mocks.listSubscriptions.mockResolvedValue({
			data: [
				{ id: "sub_old", status: "canceled", metadata: {} },
				{ id: "sub_baa", status: "active", metadata: { type: "signed_baa" } },
			],
		});

		const response = await subscribe();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: "https://checkout.stripe.com/c/pay/cs_desktop",
		});
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_1",
				metadata: expect.objectContaining({ dubCustomerId: "user-1" }),
			}),
		);
	});
});
