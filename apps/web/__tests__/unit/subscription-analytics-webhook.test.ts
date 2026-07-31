import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	product: vi.fn(),
	constructEvent: vi.fn(),
	retrieveCustomer: vi.fn(),
	retrieveSubscription: vi.fn(),
}));

const dbChain = {
	select: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
};

vi.mock("@/lib/analytics/server", () => ({
	queueServerProductEvent: mocks.product,
}));
vi.mock("@/lib/developer-credits", () => ({ addCreditsToAccount: vi.fn() }));
vi.mock("@cap/database", () => ({ db: () => dbChain }));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "new-user" }));
vi.mock("@cap/database/schema", () => ({
	developerCreditTransactions: {},
	users: {
		id: "id",
		email: "email",
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" }),
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		webhooks: { constructEvent: mocks.constructEvent },
		customers: {
			retrieve: mocks.retrieveCustomer,
			update: vi.fn(),
		},
		subscriptions: {
			retrieve: mocks.retrieveSubscription,
			list: vi.fn(),
		},
	}),
}));
vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (value: string) => value } },
	User: { UserId: { make: (value: string) => value } },
}));
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => args,
	eq: (left: unknown, right: unknown) => ({ left, right }),
}));

const dbUser = {
	id: "user-1",
	email: "user@example.com",
	activeOrganizationId: "org-1",
	stripeSubscriptionId: null,
	name: "User",
};

const customer = {
	id: "cus_1",
	deleted: false,
	email: "user@example.com",
	metadata: { userId: "user-1" },
};

const subscription = {
	id: "sub_1",
	status: "active",
	items: {
		data: [
			{
				quantity: 3,
				price: {
					id: "price_team",
					unit_amount: 900,
					recurring: { interval: "month", interval_count: 1 },
				},
			},
		],
	},
};

function session(overrides: Record<string, unknown> = {}) {
	return {
		id: "cs_1",
		customer: "cus_1",
		subscription: "sub_1",
		payment_status: "paid",
		amount_total: 2700,
		amount_subtotal: 3000,
		currency: "usd",
		total_details: { amount_discount: 300 },
		metadata: {
			platform: "web",
			analyticsAnonymousId: "anonymous-1",
			analyticsIsFirstPurchase: "true",
		},
		...overrides,
	};
}

function request() {
	return new Request("https://cap.so/api/webhooks/stripe", {
		method: "POST",
		headers: { "Stripe-Signature": "signature" },
		body: "{}",
	});
}

function event(type: string, checkoutSession: ReturnType<typeof session>) {
	return {
		id: `evt_${type}`,
		created: 1_752_537_600,
		type,
		data: { object: checkoutSession },
	};
}

describe("Stripe subscription analytics", () => {
	let POST: typeof import("@/app/api/webhooks/stripe/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		dbChain.select.mockReturnValue(dbChain);
		dbChain.from.mockReturnValue(dbChain);
		dbChain.where.mockReturnValue(dbChain);
		dbChain.limit.mockResolvedValue([dbUser]);
		dbChain.update.mockReturnValue(dbChain);
		dbChain.set.mockReturnValue(dbChain);
		mocks.retrieveCustomer.mockResolvedValue(customer);
		mocks.retrieveSubscription.mockResolvedValue(subscription);
		POST = (await import("@/app/api/webhooks/stripe/route")).POST;
	});

	it("emits a paid purchase with revenue dimensions and deterministic IDs", async () => {
		mocks.constructEvent.mockReturnValue(
			event("checkout.session.completed", session()),
		);
		expect((await POST(request())).status).toBe(200);

		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "stripe:evt_checkout.session.completed:purchase_completed",
				eventName: "purchase_completed",
				occurredAt: "2025-07-15T00:00:00.000Z",
				anonymousId: "anonymous-1",
				userId: "user-1",
				organizationId: "org-1",
				properties: expect.objectContaining({
					payment_status: "paid",
					amount_total_minor: 2700,
					currency: "usd",
					unit_amount_minor: 900,
					billing_interval: "month",
					quantity: 3,
				}),
			}),
		);
	});

	it("keeps first-purchase attribution stable on duplicate delivery", async () => {
		dbChain.limit.mockResolvedValue([
			{ ...dbUser, stripeSubscriptionId: "sub_1" },
		]);
		mocks.constructEvent.mockReturnValue(
			event("checkout.session.completed", session()),
		);

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				properties: expect.objectContaining({
					is_first_purchase: true,
				}),
			}),
		);
	});

	it("does not count an unpaid checkout as a purchase", async () => {
		mocks.constructEvent.mockReturnValue(
			event(
				"checkout.session.completed",
				session({ payment_status: "unpaid" }),
			),
		);
		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).not.toHaveBeenCalled();
	});

	it("emits when an asynchronous subscription payment settles", async () => {
		mocks.constructEvent.mockReturnValue(
			event("checkout.session.async_payment_succeeded", session()),
		);
		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId:
					"stripe:evt_checkout.session.async_payment_succeeded:purchase_completed",
				userId: "user-1",
			}),
		);
	});

	it("records a no-payment trial without counting a purchase", async () => {
		mocks.retrieveSubscription.mockResolvedValue({
			...subscription,
			status: "trialing",
		});
		mocks.constructEvent.mockReturnValue(
			event(
				"checkout.session.completed",
				session({
					payment_status: "no_payment_required",
					amount_total: 0,
				}),
			),
		);
		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "stripe:evt_checkout.session.completed:trial_started",
				eventName: "trial_started",
				properties: expect.objectContaining({
					subscription_status: "trialing",
				}),
			}),
		);
		expect(mocks.product).not.toHaveBeenCalledWith(
			expect.objectContaining({ eventName: "purchase_completed" }),
		);
	});

	it("records only the incremental amount for partial refunds", async () => {
		mocks.constructEvent.mockReturnValue({
			id: "evt_refund_2",
			created: 1_752_537_600,
			type: "charge.refunded",
			data: {
				object: {
					id: "ch_1",
					customer: "cus_1",
					invoice: "in_1",
					amount_refunded: 500,
					currency: "usd",
					refunded: false,
				},
				previous_attributes: { amount_refunded: 200 },
			},
		});

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "stripe:evt_refund_2:subscription_refunded",
				eventName: "subscription_refunded",
				properties: {
					amount_refunded_minor: 300,
					currency: "usd",
					fully_refunded: false,
				},
			}),
		);
	});
});
