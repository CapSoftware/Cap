import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	ensureStripeCustomerId: vi.fn(),
	trackServerEvent: vi.fn(),
	deferred: [] as Array<() => unknown>,
	stripe: {
		prices: { retrieve: vi.fn() },
		subscriptions: { list: vi.fn() },
		checkout: {
			sessions: { create: vi.fn(), list: vi.fn(), expire: vi.fn() },
		},
	},
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		VERCEL_ENV: "development",
		WEB_URL: "https://cap.test",
	}),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({
	after: (task: () => unknown) => {
		mocks.deferred.push(task);
	},
}));
vi.mock("@/lib/checkout/customer", () => ({
	ensureStripeCustomerId: mocks.ensureStripeCustomerId,
}));
vi.mock("@/lib/checkout/enabled", () => ({
	customCheckoutEnabled: () => true,
}));
vi.mock("@/lib/checkout/stripe", () => ({
	checkoutStripe: () => mocks.stripe,
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: vi.fn(async () => false),
	RATE_LIMIT_IDS: { GUEST_CHECKOUT: "guest-checkout" },
}));
vi.mock("@/lib/server-analytics", () => ({
	trackServerEvent: mocks.trackServerEvent,
}));

import { createProCheckout } from "@/actions/billing/checkout";

const signedInUser = {
	id: "user-1",
	email: "buyer@example.com",
	stripeCustomerId: "cus_1",
	stripeSubscriptionStatus: null,
	thirdPartyStripeSubscriptionId: null,
};

const subscription = (
	status: string,
	metadata: Record<string, string> = {},
) => ({
	id: `sub_${status}`,
	status,
	metadata,
	items: { data: [{ price: { id: "price_pro" } }] },
});

const openSession = (id: string, metadata: Record<string, string>) => ({
	id,
	status: "open",
	metadata,
});

const runDeferred = () =>
	Promise.all(mocks.deferred.splice(0).map((task) => task()));

const checkout = () =>
	createProCheckout({ plan: "monthly", seats: 2, onboarding: false });

describe("createProCheckout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deferred.length = 0;
		mocks.getCurrentUser.mockResolvedValue(signedInUser);
		mocks.ensureStripeCustomerId.mockResolvedValue("cus_1");
		mocks.stripe.prices.retrieve.mockResolvedValue({
			currency: "usd",
			currency_options: {},
		});
		mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
		mocks.stripe.checkout.sessions.create.mockResolvedValue({
			id: "cs_new",
			client_secret: "cs_new_secret_x",
		});
		mocks.stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
		mocks.stripe.checkout.sessions.expire.mockResolvedValue({});
	});

	it.each(["active", "trialing", "past_due"])(
		"does not open a checkout when the buyer's Stripe customer already has a %s Pro subscription",
		async (status) => {
			mocks.stripe.subscriptions.list.mockResolvedValue({
				data: [subscription("canceled"), subscription(status)],
			});

			expect(await checkout()).toEqual({ ok: false, reason: "already_pro" });
			expect(mocks.stripe.subscriptions.list).toHaveBeenCalledWith({
				customer: "cus_1",
				limit: 100,
			});
			expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
			expect(mocks.deferred).toEqual([]);
		},
	);

	it("opens a checkout for the buyer when their earlier subscriptions have ended", async () => {
		mocks.stripe.subscriptions.list.mockResolvedValue({
			data: [
				subscription("canceled"),
				subscription("incomplete_expired"),
				subscription("active", { type: "signed_baa" }),
			],
		});

		expect(await checkout()).toEqual({
			ok: true,
			clientSecret: "cs_new_secret_x",
		});
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_1",
				metadata: expect.objectContaining({ dubCustomerId: "user-1" }),
			}),
		);
	});

	it("expires the buyer's other open in-app checkouts once the new one exists", async () => {
		mocks.stripe.checkout.sessions.list.mockResolvedValue({
			data: [
				openSession("cs_old", {
					checkoutUi: "elements",
					dubCustomerId: "user-1",
				}),
				openSession("cs_new", {
					checkoutUi: "elements",
					dubCustomerId: "user-1",
				}),
				openSession("cs_hosted", { dubCustomerId: "user-1" }),
				openSession("cs_other_user", {
					checkoutUi: "elements",
					dubCustomerId: "user-2",
				}),
			],
		});

		expect(await checkout()).toEqual({
			ok: true,
			clientSecret: "cs_new_secret_x",
		});
		await runDeferred();

		expect(mocks.stripe.checkout.sessions.list).toHaveBeenCalledWith({
			customer: "cus_1",
			status: "open",
			limit: 100,
		});
		expect(mocks.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
		expect(mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
			"cs_old",
		);
	});

	it("keeps the new checkout when an earlier one can no longer be expired", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mocks.stripe.checkout.sessions.list.mockResolvedValue({
			data: [
				openSession("cs_old", {
					checkoutUi: "elements",
					dubCustomerId: "user-1",
				}),
			],
		});
		mocks.stripe.checkout.sessions.expire.mockRejectedValue(
			new Error("session is complete"),
		);

		expect(await checkout()).toEqual({
			ok: true,
			clientSecret: "cs_new_secret_x",
		});
		await runDeferred();

		expect(mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
			"cs_old",
		);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("opens a guest checkout without looking up a customer", async () => {
		mocks.getCurrentUser.mockResolvedValue(null);

		expect(await checkout()).toEqual({
			ok: true,
			clientSecret: "cs_new_secret_x",
		});
		await runDeferred();

		expect(mocks.ensureStripeCustomerId).not.toHaveBeenCalled();
		expect(mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
		expect(mocks.stripe.checkout.sessions.list).not.toHaveBeenCalled();
		const params = mocks.stripe.checkout.sessions.create.mock.calls[0]?.[0];
		expect(params).not.toHaveProperty("customer");
		expect(params.metadata).toMatchObject({ guestCheckout: "true" });
	});

	it("does not reach Stripe for a buyer already recorded as Pro", async () => {
		mocks.getCurrentUser.mockResolvedValue({
			...signedInUser,
			stripeSubscriptionStatus: "active",
		});

		expect(await checkout()).toEqual({ ok: false, reason: "already_pro" });
		expect(mocks.ensureStripeCustomerId).not.toHaveBeenCalled();
		expect(mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});
});
