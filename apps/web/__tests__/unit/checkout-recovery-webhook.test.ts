import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbChain = {
	select: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
	values: vi.fn(),
};

/** Rows `findUserWithRetry` should resolve to, in call order. */
let userLookupResults: Array<Array<Record<string, unknown>>> = [];

function resetDbChain() {
	for (const key of Object.keys(mockDbChain)) {
		mockDbChain[key as keyof typeof mockDbChain].mockClear();
	}
	mockDbChain.select.mockReturnValue(mockDbChain);
	mockDbChain.from.mockReturnValue(mockDbChain);
	mockDbChain.where.mockReturnValue(mockDbChain);
	mockDbChain.limit.mockImplementation(() =>
		Promise.resolve(userLookupResults.shift() ?? []),
	);
	mockDbChain.insert.mockReturnValue(mockDbChain);
	mockDbChain.update.mockReturnValue(mockDbChain);
	mockDbChain.set.mockReturnValue(mockDbChain);
	mockDbChain.values.mockReturnValue(Promise.resolve());
}

const sendEmail = vi.fn().mockResolvedValue(undefined);
const trackServerEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("@cap/database", () => ({ db: () => mockDbChain }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "test-nano-id"),
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail }));
vi.mock("@cap/database/emails/payment-failed", () => ({
	PaymentFailed: vi.fn(() => null),
}));
vi.mock("@cap/database/emails/checkout-recovery", () => ({
	CheckoutRecovery: vi.fn((props: unknown) => props),
}));
vi.mock("@cap/database/schema", () => ({
	developerCreditTransactions: {},
	signedBaas: {},
	users: { id: "id", email: "email" },
}));
vi.mock("@cap/env", () => ({
	buildEnv: {},
	serverEnv: () => ({
		STRIPE_WEBHOOK_SECRET: "whsec_test",
		WEB_URL: "https://cap.so",
	}),
}));
vi.mock("@/lib/developer-credits", () => ({ addCreditsToAccount: vi.fn() }));
vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (v: string) => v } },
	User: { UserId: { make: (v: string) => v } },
}));

const mockStripe = {
	webhooks: { constructEvent: vi.fn() },
	customers: { retrieve: vi.fn() },
	subscriptions: { retrieve: vi.fn(), list: vi.fn(), cancel: vi.fn() },
};

vi.mock("@cap/utils", () => ({
	stripe: () => mockStripe,
	userIsPro: (user?: { stripeSubscriptionStatus?: string | null } | null) =>
		user?.stripeSubscriptionStatus === "active",
	STRIPE_PLAN_IDS: {
		development: { yearly: "price_dev_yearly", monthly: "price_dev_monthly" },
		production: { yearly: "price_prod_yearly", monthly: "price_prod_monthly" },
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
	isNull: vi.fn((a: unknown) => ({ isNull: a })),
	or: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@/lib/server-analytics", () => ({ trackServerEvent }));

function makeWebhookRequest() {
	return new Request("https://cap.test/api/webhooks/stripe", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Stripe-Signature": "sig_test",
		},
		body: "{}",
	});
}

function expiredSession(overrides: Record<string, unknown> = {}) {
	return {
		type: "checkout.session.expired",
		// 2026-08-20T12:00:00Z
		created: 1787227200,
		data: {
			object: {
				id: "cs_expired_1",
				mode: "subscription",
				customer: "cus_1",
				customer_details: { email: "abandoner@example.com" },
				metadata: { platform: "web", priceId: "price_dev_monthly" },
				after_expiration: {
					recovery: { url: "https://pay.cap.so/recover/cs_expired_1" },
				},
				...overrides,
			},
		},
	};
}

describe("Stripe webhook — abandoned checkout recovery", () => {
	let POST: typeof import("@/app/api/webhooks/stripe/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		userLookupResults = [];
		resetDbChain();
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "abandoner@example.com",
			metadata: { userId: "user-1" },
		});
		const mod = await import("@/app/api/webhooks/stripe/route");
		POST = mod.POST;
	});

	it("emails the recovery link to a free user who abandoned checkout", async () => {
		userLookupResults = [
			[
				{
					id: "user-1",
					email: "abandoner@example.com",
					stripeSubscriptionStatus: null,
				},
			],
		];
		mockStripe.webhooks.constructEvent.mockReturnValue(expiredSession());

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(sendEmail).toHaveBeenCalledTimes(1);
		const call = sendEmail.mock.calls[0]?.[0];
		expect(call.email).toBe("abandoner@example.com");
		expect(call.react).toMatchObject({
			recoveryUrl: "https://pay.cap.so/recover/cs_expired_1",
			interval: "month",
		});
		// Day-bucketed so several abandoned sessions in one day send one email.
		expect(call.idempotencyKey).toBe("checkout-recovery-user-1-2026-08-20");
		expect(trackServerEvent).toHaveBeenCalledWith(
			"user-1",
			"checkout_recovery_email_sent",
			expect.objectContaining({ interval: "month" }),
		);
	});

	it("does not email a user who is already on a paid plan", async () => {
		userLookupResults = [
			[
				{
					id: "user-1",
					email: "abandoner@example.com",
					stripeSubscriptionStatus: "active",
				},
			],
		];
		mockStripe.webhooks.constructEvent.mockReturnValue(expiredSession());

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("never cold-emails someone without a Cap account", async () => {
		userLookupResults = [[], []];
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "stranger@example.com",
			metadata: {},
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(expiredSession());

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("ignores expired sessions with no recovery URL", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue(
			expiredSession({ after_expiration: null }),
		);

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
	});

	it("ignores non-Pro checkouts that expire", async () => {
		for (const overrides of [
			{ mode: "payment" },
			{ metadata: { type: "developer_credits" } },
			{ metadata: { type: "signed_baa" } },
		]) {
			vi.clearAllMocks();
			mockStripe.webhooks.constructEvent.mockReturnValue(
				expiredSession(overrides),
			);

			const res = await POST(makeWebhookRequest());

			expect(res.status).toBe(200);
			expect(sendEmail).not.toHaveBeenCalled();
		}
	});

	it("does not count an email Resend suppressed as a duplicate", async () => {
		userLookupResults = [
			[
				{
					id: "user-1",
					email: "abandoner@example.com",
					stripeSubscriptionStatus: null,
				},
			],
		];
		// Resend reports a reused idempotency key in the body, it does not throw.
		sendEmail.mockResolvedValueOnce({
			data: null,
			error: { message: "Idempotency key already used" },
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(expiredSession());

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(trackServerEvent).not.toHaveBeenCalledWith(
			"user-1",
			"checkout_recovery_email_sent",
			expect.anything(),
		);
	});

	it("keeps the webhook healthy when the email provider rejects the send", async () => {
		userLookupResults = [
			[
				{
					id: "user-1",
					email: "abandoner@example.com",
					stripeSubscriptionStatus: null,
				},
			],
		];
		sendEmail.mockRejectedValueOnce(new Error("duplicate idempotency key"));
		mockStripe.webhooks.constructEvent.mockReturnValue(expiredSession());

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
	});
});
