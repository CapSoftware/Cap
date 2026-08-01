import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	eventsList: vi.fn(),
	invoicesList: vi.fn(),
	retrieveInvoice: vi.fn(),
	retrieveSubscription: vi.fn(),
	queueDurableServerProductEvent: vi.fn(),
	users: [] as Array<{
		id: string;
		activeOrganizationId: string;
		stripeCustomerId: string;
	}>,
}));

const dbChain = {
	delete: vi.fn(),
	insert: vi.fn(),
	onDuplicateKeyUpdate: vi.fn(),
	select: vi.fn(),
	from: vi.fn(),
	values: vi.fn(),
	where: vi.fn(),
};

vi.mock("@cap/database", () => ({ db: () => dbChain }));
vi.mock("@cap/database/schema", () => ({
	comments: {},
	messengerSupportEmails: {},
	productAnalyticsReconciliationFailures: {
		attemptCount: "productAnalyticsReconciliationFailures.attemptCount",
		sourceHash: "productAnalyticsReconciliationFailures.sourceHash",
	},
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
	asc: (value: unknown) => value,
	eq: (left: unknown, right: unknown) => ({ left, right }),
	gt: (left: unknown, right: unknown) => ({ left, right }),
	gte: (left: unknown, right: unknown) => ({ left, right }),
	inArray: (left: unknown, right: unknown) => ({ left, right }),
	isNotNull: (value: unknown) => value,
	lte: (left: unknown, right: unknown) => ({ left, right }),
	notInArray: (left: unknown, right: unknown) => ({ left, right }),
	or: (...values: unknown[]) => values,
	sql: (...values: unknown[]) => values,
}));
vi.mock("@/lib/account-deletion-request", () => ({
	ACCOUNT_DELETION_PENDING_SUBJECT: "pending-deletion",
}));
vi.mock("@/lib/analytics/product-event-outbox", () => ({
	queueDurableServerProductEvent: mocks.queueDurableServerProductEvent,
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
		dbChain.delete.mockReturnValue(dbChain);
		dbChain.insert.mockReturnValue(dbChain);
		dbChain.from.mockReturnValue(dbChain);
		dbChain.values.mockReturnValue(dbChain);
		dbChain.onDuplicateKeyUpdate.mockResolvedValue(undefined);
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
		mocks.queueDurableServerProductEvent.mockResolvedValue({
			deliveryKey: "delivery-key",
			status: "started",
		});
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
			failed: 0,
			legacyStripeEventsSkipped: 0,
			reconciled: 1,
		});
		expect(mocks.queueDurableServerProductEvent).toHaveBeenCalledWith(
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
		);
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
			failed: 0,
			legacyStripeEventsSkipped: 1,
			reconciled: 1,
		});
		expect(mocks.queueDurableServerProductEvent).toHaveBeenCalledWith(
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
		);
	});

	it("quarantines a paid checkout that cannot be tied to a Cap user", async () => {
		mocks.users.splice(0);
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		await expect(
			loadStripeAnalyticsReconciliationEventsStep({
				scheduledAt: "2025-07-16T00:00:00.000Z",
				lookbackHours: 48,
			}),
		).resolves.toEqual({
			failed: 1,
			legacyStripeEventsSkipped: 0,
			reconciled: 0,
		});
		expect(dbChain.insert).toHaveBeenCalled();
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

		expect(result).toEqual({
			failed: 0,
			legacyStripeEventsSkipped: 0,
			reconciled: 1,
		});
		expect(mocks.queueDurableServerProductEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "stripe:evt_trial:trial_started",
				eventName: "trial_started",
				occurredAt: "2025-07-15T00:00:00.000Z",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
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
			subscription_details: { metadata: subscription.metadata },
			lines: {
				data: [
					{
						quantity: 3,
						metadata: subscription.metadata,
						price: subscription.items.data[0]?.price,
					},
				],
			},
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

		expect(result).toEqual({
			failed: 0,
			legacyStripeEventsSkipped: 0,
			reconciled: 1,
		});
		expect(mocks.queueDurableServerProductEvent).toHaveBeenCalledWith(
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
		);
	});

	it("reconciles more than 5,000 Stripe facts without a hard row cap", async () => {
		const total = 5_101;
		mocks.eventsList.mockImplementation(
			async ({
				type,
				starting_after: startingAfter,
			}: {
				type: string;
				starting_after?: string;
			}) => {
				if (type !== "checkout.session.created") {
					return { data: [], has_more: false };
				}
				const offset = startingAfter
					? Number(startingAfter.split("_").at(-1)) + 1
					: 0;
				const count = Math.min(100, total - offset);
				return {
					data: Array.from({ length: count }, (_, index) => {
						const sequence = offset + index;
						return {
							id: `evt_created_${sequence}`,
							created: 1_752_537_600,
							type,
							data: {
								object: {
									...checkoutSession,
									id: `cs_created_${sequence}`,
								},
							},
						};
					}),
					has_more: offset + count < total,
				};
			},
		);
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		await expect(
			loadStripeAnalyticsReconciliationEventsStep({
				scheduledAt: "2025-07-16T00:00:00.000Z",
				lookbackHours: 48,
			}),
		).resolves.toEqual({
			failed: 0,
			legacyStripeEventsSkipped: 0,
			reconciled: total,
		});
		expect(mocks.queueDurableServerProductEvent).toHaveBeenCalledTimes(total);
	});

	it("resumes from the last durable Stripe page after a later page fails", async () => {
		let secondPageAttempts = 0;
		mocks.eventsList.mockImplementation(
			async ({
				starting_after: startingAfter,
				type,
			}: {
				starting_after?: string;
				type: string;
			}) => {
				if (type !== "checkout.session.completed") {
					return { data: [], has_more: false };
				}
				if (!startingAfter) {
					return {
						data: [
							{
								id: "evt_page_1",
								created: 1_752_537_600,
								type,
								data: { object: checkoutSession },
							},
						],
						has_more: true,
					};
				}
				secondPageAttempts += 1;
				if (secondPageAttempts === 1)
					throw new Error("temporary Stripe outage");
				return {
					data: [
						{
							id: "evt_page_2",
							created: 1_752_537_601,
							type,
							data: {
								object: { ...checkoutSession, id: "cs_page_2" },
							},
						},
					],
					has_more: false,
				};
			},
		);
		const { loadStripeAnalyticsReconciliationPageStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);
		const input = {
			scheduledAt: "2025-07-16T00:00:00.000Z",
			lookbackHours: 48,
			type: "checkout.session.completed" as const,
		};
		const firstPage = await loadStripeAnalyticsReconciliationPageStep(input);
		expect(firstPage.nextStartingAfter).toBe("evt_page_1");
		await expect(
			loadStripeAnalyticsReconciliationPageStep({
				...input,
				startingAfter: firstPage.nextStartingAfter,
			}),
		).rejects.toThrow("temporary Stripe outage");
		await expect(
			loadStripeAnalyticsReconciliationPageStep({
				...input,
				startingAfter: firstPage.nextStartingAfter,
			}),
		).resolves.toEqual({
			failed: 0,
			legacyStripeEventsSkipped: 0,
			nextStartingAfter: undefined,
			reconciled: 1,
		});
		expect(
			mocks.eventsList.mock.calls.filter(
				([request]) => request.starting_after === "evt_page_1",
			),
		).toHaveLength(2);
		expect(mocks.queueDurableServerProductEvent).toHaveBeenCalledTimes(2);
	});
});
