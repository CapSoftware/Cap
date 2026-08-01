import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	product: vi.fn(),
	constructEvent: vi.fn(),
	retrieveCustomer: vi.fn(),
	retrieveInvoice: vi.fn(),
	retrieveSubscription: vi.fn(),
	listInvoices: vi.fn(),
	listSubscriptions: vi.fn(),
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
			list: mocks.listSubscriptions,
		},
		invoices: {
			retrieve: mocks.retrieveInvoice,
			list: mocks.listInvoices,
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
	customer: "cus_1",
	status: "active",
	metadata: {
		platform: "web",
		analyticsAnonymousId: "anonymous-1",
		analyticsSchemaVersion: "1",
		analyticsPriceId: "price_team",
		analyticsQuantity: "3",
		analyticsOrganizationId: "org-immutable",
		analyticsIsFirstPurchase: "true",
	},
	cancel_at_period_end: false,
	ended_at: null,
	items: {
		data: [
			{
				quantity: 3,
				price: {
					id: "price_team",
					currency: "usd",
					unit_amount: 900,
					recurring: { interval: "month", interval_count: 1 },
				},
			},
		],
	},
};

const invoice = {
	id: "in_1",
	created: 1_752_537_600,
	customer: "cus_1",
	subscription: "sub_1",
	billing_reason: "subscription_cycle",
	amount_paid: 2_700,
	amount_due: 2_700,
	attempt_count: 1,
	subtotal: 3_000,
	currency: "usd",
	total_discount_amounts: [{ amount: 300 }],
	subscription_details: { metadata: subscription.metadata },
	lines: {
		data: [
			{
				subscription: "sub_1",
				quantity: 3,
				metadata: subscription.metadata,
				price: subscription.items.data[0]?.price,
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
			analyticsSchemaVersion: "1",
			analyticsPriceId: "price_team",
			analyticsQuantity: "3",
			analyticsOrganizationId: "org-1",
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

function event(type: string, object: unknown) {
	return {
		id: `evt_${type}`,
		created: 1_752_537_600,
		type,
		data: { object },
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
		mocks.retrieveInvoice.mockResolvedValue(invoice);
		mocks.listInvoices.mockResolvedValue({ data: [], has_more: false });
		mocks.listSubscriptions.mockResolvedValue({ data: [subscription] });
		POST = (await import("@/app/api/webhooks/stripe/route")).POST;
	});

	afterEach(() => {
		vi.useRealTimers();
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
					subscription_status: "paid_checkout",
					amount_total_minor: 2700,
					currency: "usd",
					price_id: "price_team",
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

	it("does not substitute a mutable organization into immutable checkout metadata", async () => {
		const metadata = session().metadata;
		mocks.constructEvent.mockReturnValue(
			event(
				"checkout.session.completed",
				session({
					metadata: {
						...metadata,
						analyticsOrganizationId: undefined,
					},
				}),
			),
		);

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: undefined }),
		);
	});

	it("skips legacy checkouts without immutable analytics metadata", async () => {
		mocks.constructEvent.mockReturnValue(
			event(
				"checkout.session.completed",
				session({ metadata: { platform: "web" } }),
			),
		);

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).not.toHaveBeenCalled();
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

	it("replays the same Stripe event as the same decision event", async () => {
		mocks.constructEvent.mockReturnValue(
			event("checkout.session.completed", session()),
		);
		await POST(request());
		await POST(request());

		expect(mocks.product).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				eventId: "stripe:evt_checkout.session.completed:purchase_completed",
			}),
		);
		expect(mocks.product).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				eventId: "stripe:evt_checkout.session.completed:purchase_completed",
			}),
		);
	});

	it("returns a retryable failure when checkout identity is not available", async () => {
		vi.useFakeTimers();
		dbChain.limit.mockResolvedValue([]);
		mocks.constructEvent.mockReturnValue(
			event("checkout.session.completed", session()),
		);

		const responsePromise = POST(request());
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(mocks.product).not.toHaveBeenCalled();
	});

	it("does not emit an unattributed asynchronous purchase", async () => {
		dbChain.limit.mockResolvedValue([]);
		mocks.constructEvent.mockReturnValue(
			event("checkout.session.async_payment_succeeded", session()),
		);

		expect((await POST(request())).status).toBe(503);
		expect(mocks.product).not.toHaveBeenCalled();
	});

	it("retries subscription changes until identity is available", async () => {
		vi.useFakeTimers();
		dbChain.limit.mockResolvedValue([]);
		mocks.constructEvent.mockReturnValue(
			event("customer.subscription.updated", {
				...subscription,
				customer: "cus_1",
			}),
		);

		const responsePromise = POST(request());
		await vi.runAllTimersAsync();

		expect((await responsePromise).status).toBe(503);
		expect(mocks.product).not.toHaveBeenCalled();
	});

	it("records a no-payment trial without counting a purchase", async () => {
		mocks.constructEvent.mockReturnValue(
			event("customer.subscription.created", {
				...subscription,
				customer: "cus_1",
				status: "trialing",
				trial_end: 1_753_142_400,
				metadata: session().metadata,
			}),
		);
		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "stripe:evt_customer.subscription.created:trial_started",
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
					price_id: "price_team",
					fully_refunded: false,
				},
			}),
		);
	});

	it("counts the first positive post-trial invoice as the purchase", async () => {
		mocks.retrieveSubscription.mockResolvedValue({
			...subscription,
			metadata: {
				...subscription.metadata,
				analyticsOrganizationId: "org-mutated",
			},
		});
		mocks.constructEvent.mockReturnValue(event("invoice.paid", invoice));

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "stripe:evt_invoice.paid:purchase_completed",
				eventName: "purchase_completed",
				platform: "web",
				organizationId: "org-immutable",
				properties: expect.objectContaining({
					amount_total_minor: 2_700,
					is_first_purchase: true,
				}),
			}),
		);
		expect(mocks.product).not.toHaveBeenCalledWith(
			expect.objectContaining({ eventName: "subscription_renewed" }),
		);
		expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
	});

	it("counts a later positive subscription invoice as a renewal", async () => {
		mocks.listInvoices.mockResolvedValue({
			data: [{ id: "in_prior", amount_paid: 2_700 }],
			has_more: false,
		});
		mocks.constructEvent.mockReturnValue(event("invoice.paid", invoice));

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "stripe:evt_invoice.paid:subscription_renewed",
				eventName: "subscription_renewed",
				organizationId: "org-immutable",
			}),
		);
		expect(mocks.product).not.toHaveBeenCalledWith(
			expect.objectContaining({ eventName: "purchase_completed" }),
		);
	});

	it("records provider-authoritative failed collection attempts", async () => {
		mocks.constructEvent.mockReturnValue(
			event("invoice.payment_failed", {
				...invoice,
				amount_paid: 0,
				amount_due: 2_700,
				attempt_count: 2,
			}),
		);

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId:
					"stripe:evt_invoice.payment_failed:subscription_payment_failed",
				eventName: "subscription_payment_failed",
				organizationId: "org-immutable",
				properties: expect.objectContaining({
					amount_due_minor: 2_700,
					attempt_count: 2,
				}),
			}),
		);
	});

	it("emits both plan and seat changes from one Stripe update", async () => {
		mocks.constructEvent.mockReturnValue({
			...event("customer.subscription.updated", subscription),
			data: {
				object: subscription,
				previous_attributes: {
					items: {
						data: [
							{
								quantity: 1,
								price: { id: "price_pro" },
							},
						],
					},
				},
			},
		});

		expect((await POST(request())).status).toBe(200);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId:
					"stripe:evt_customer.subscription.updated:subscription_changed:plan",
				properties: expect.objectContaining({ change_kind: "plan" }),
			}),
		);
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId:
					"stripe:evt_customer.subscription.updated:subscription_changed:seats",
				properties: expect.objectContaining({ change_kind: "seats" }),
			}),
		);
	});
});
