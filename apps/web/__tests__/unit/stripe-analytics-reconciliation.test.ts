import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	eventsList: vi.fn(),
	invoicesList: vi.fn(),
	retrieveInvoice: vi.fn(),
	retrieveSubscription: vi.fn(),
	users: [] as Array<{
		id: string;
		activeOrganizationId: string;
		stripeCustomerId: string;
	}>,
}));

const dbChain = {
	select: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
};

vi.mock("@cap/database", () => ({ db: () => dbChain }));
vi.mock("@cap/database/schema", () => ({
	comments: {},
	messengerSupportEmails: {},
	users: {
		id: "users.id",
		activeOrganizationId: "users.activeOrganizationId",
		stripeCustomerId: "users.stripeCustomerId",
	},
	videos: {},
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		events: { list: mocks.eventsList },
		invoices: {
			list: mocks.invoicesList,
			retrieve: mocks.retrieveInvoice,
		},
		subscriptions: { retrieve: mocks.retrieveSubscription },
	}),
}));
vi.mock("drizzle-orm", () => ({
	and: (...values: unknown[]) => values,
	eq: (left: unknown, right: unknown) => ({ left, right }),
	gte: (left: unknown, right: unknown) => ({ left, right }),
	inArray: (left: unknown, right: unknown) => ({ left, right }),
	isNotNull: (value: unknown) => value,
	lte: (left: unknown, right: unknown) => ({ left, right }),
	notInArray: (left: unknown, right: unknown) => ({ left, right }),
}));
vi.mock("@/lib/account-deletion-request", () => ({
	ACCOUNT_DELETION_PENDING_SUBJECT: "pending-deletion",
}));
vi.mock("@/workflows/deliver-product-analytics-event", () => ({
	enqueueReconciledProductAnalyticsEventStep: vi.fn(),
}));

const checkoutSession = {
	id: "cs_1",
	created: 1_752_537_600,
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
};

const subscription = {
	id: "sub_1",
	customer: "cus_1",
	status: "active",
	metadata: checkoutSession.metadata,
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

describe("Stripe analytics reconciliation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.users.splice(0, mocks.users.length, {
			id: "user-1",
			activeOrganizationId: "org-1",
			stripeCustomerId: "cus_1",
		});
		dbChain.select.mockReturnValue(dbChain);
		dbChain.from.mockReturnValue(dbChain);
		dbChain.where.mockImplementation(async () => [...mocks.users]);
		mocks.eventsList.mockImplementation(async ({ type }: { type: string }) => ({
			data:
				type === "checkout.session.completed"
					? [
							{
								id: "evt_checkout",
								created: 1_752_537_600,
								type,
								data: { object: checkoutSession },
							},
						]
					: [],
			has_more: false,
		}));
		mocks.retrieveSubscription.mockResolvedValue(subscription);
		mocks.invoicesList.mockResolvedValue({ data: [], has_more: false });
	});

	it("rebuilds Stripe checkout facts with the original event identity", async () => {
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		const result = await loadStripeAnalyticsReconciliationEventsStep({
			scheduledAt: "2025-07-16T00:00:00.000Z",
			lookbackHours: 48,
		});

		expect(result).toEqual({
			legacyStripeEventsSkipped: 0,
			events: [
				expect.objectContaining({
					eventId: "stripe:evt_checkout:purchase_completed",
					eventName: "purchase_completed",
					occurredAt: "2025-07-15T00:00:00.000Z",
					userId: "user-1",
					organizationId: "org-1",
					properties: expect.objectContaining({
						amount_total_minor: 2700,
						currency: "usd",
						is_first_purchase: true,
					}),
				}),
			],
		});
		expect(mocks.eventsList.mock.calls.map(([input]) => input.type)).toEqual([
			"checkout.session.created",
			"checkout.session.completed",
			"checkout.session.async_payment_succeeded",
			"charge.refunded",
			"invoice.paid",
			"invoice.payment_failed",
			"customer.subscription.created",
			"customer.subscription.updated",
			"customer.subscription.deleted",
		]);
	});

	it("rebuilds versioned checkout metadata and counts legacy sessions", async () => {
		mocks.users[0] = {
			id: "user-1",
			activeOrganizationId: "org-2",
			stripeCustomerId: "cus_1",
		};
		mocks.eventsList.mockImplementation(async ({ type }: { type: string }) => ({
			data:
				type === "checkout.session.created"
					? [
							{
								id: "evt_legacy",
								created: 1_752_537_500,
								type,
								data: {
									object: {
										...checkoutSession,
										id: "cs_legacy",
										metadata: { platform: "web" },
									},
								},
							},
							{
								id: "evt_created",
								created: 1_752_537_600,
								type,
								data: { object: checkoutSession },
							},
						]
					: [],
			has_more: false,
		}));
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		const result = await loadStripeAnalyticsReconciliationEventsStep({
			scheduledAt: "2025-07-16T00:00:00.000Z",
			lookbackHours: 48,
		});

		expect(result).toEqual({
			legacyStripeEventsSkipped: 1,
			events: [
				expect.objectContaining({
					eventId: "checkout:cs_1",
					eventName: "checkout_started",
					occurredAt: "2025-07-15T00:00:00.000Z",
					organizationId: "org-1",
					properties: expect.objectContaining({
						price_id: "price_team",
						quantity: 3,
					}),
				}),
			],
		});
	});

	it("fails closed when a paid checkout cannot be tied to a Cap user", async () => {
		mocks.users.splice(0);
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		await expect(
			loadStripeAnalyticsReconciliationEventsStep({
				scheduledAt: "2025-07-16T00:00:00.000Z",
				lookbackHours: 48,
			}),
		).rejects.toThrow("Stripe checkout has no matching analytics user");
	});

	it("rebuilds a trial from the immutable subscription-created snapshot", async () => {
		mocks.eventsList.mockImplementation(async ({ type }: { type: string }) => ({
			data:
				type === "customer.subscription.created"
					? [
							{
								id: "evt_trial",
								created: 1_752_537_600,
								type,
								data: {
									object: {
										...subscription,
										customer: "cus_1",
										status: "trialing",
										trial_end: 1_753_142_400,
										metadata: checkoutSession.metadata,
									},
								},
							},
						]
					: [],
			has_more: false,
		}));
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		const result = await loadStripeAnalyticsReconciliationEventsStep({
			scheduledAt: "2025-07-16T00:00:00.000Z",
			lookbackHours: 48,
		});

		expect(result.events).toEqual([
			expect.objectContaining({
				eventId: "stripe:evt_trial:trial_started",
				eventName: "trial_started",
				occurredAt: "2025-07-15T00:00:00.000Z",
				userId: "user-1",
				organizationId: "org-1",
			}),
		]);
	});

	it("rebuilds the first settled post-trial invoice as a purchase", async () => {
		const invoice = {
			id: "in_first_paid",
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
			lines: { data: [{ price: { id: "price_team" } }] },
		};
		mocks.eventsList.mockImplementation(async ({ type }: { type: string }) => ({
			data:
				type === "invoice.paid"
					? [
							{
								id: "evt_first_paid",
								created: 1_752_537_600,
								type,
								data: { object: invoice },
							},
						]
					: [],
			has_more: false,
		}));
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		const result = await loadStripeAnalyticsReconciliationEventsStep({
			scheduledAt: "2025-07-16T00:00:00.000Z",
			lookbackHours: 48,
		});

		expect(result.events).toEqual([
			expect.objectContaining({
				eventId: "stripe:evt_first_paid:purchase_completed",
				eventName: "purchase_completed",
				platform: "web",
				organizationId: "org-1",
				properties: expect.objectContaining({
					amount_total_minor: 2_700,
					is_first_purchase: true,
				}),
			}),
		]);
	});
});
