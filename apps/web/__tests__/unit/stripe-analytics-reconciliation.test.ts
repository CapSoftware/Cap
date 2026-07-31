import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	eventsList: vi.fn(),
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
vi.mock("@/lib/analytics/business-events", () => ({
	collaborationActionCreatedEvent: vi.fn(),
	shareLinkCreatedEvent: vi.fn(),
	userSignedUpEvent: vi.fn(),
}));
vi.mock("@/workflows/deliver-product-analytics-event", () => ({
	enqueueReconciledProductAnalyticsEventStep: vi.fn(),
}));

const checkoutSession = {
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
								data: { object: checkoutSession },
							},
						]
					: [],
			has_more: false,
		}));
		mocks.retrieveSubscription.mockResolvedValue(subscription);
	});

	it("rebuilds Stripe checkout facts with the original event identity", async () => {
		const { loadStripeAnalyticsReconciliationEventsStep } = await import(
			"@/workflows/reconcile-product-analytics"
		);

		const events = await loadStripeAnalyticsReconciliationEventsStep({
			scheduledAt: "2025-07-16T00:00:00.000Z",
			lookbackHours: 48,
		});

		expect(events).toEqual([
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
		]);
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
});
