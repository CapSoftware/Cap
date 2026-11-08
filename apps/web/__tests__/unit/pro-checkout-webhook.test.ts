import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	email: string;
	stripeSubscriptionId: string | null;
	stripeSubscriptionStatus?: string | null;
	stripeCustomerId?: string | null;
	inviteQuota?: number;
	onboarding_completed_at?: Date | null;
};

const state = {
	users: [] as Row[],
	updates: [] as Record<string, unknown>[],
	inserts: [] as Record<string, unknown>[],
};

const matches = (row: Row, condition: unknown) => {
	const eq = (condition as { eq?: [string, string] } | undefined)?.eq;
	if (!eq) return false;
	const [field, value] = eq;
	return row[field as keyof Row] === value;
};

const query = () => {
	let condition: unknown;
	let changes: Record<string, unknown> | undefined;
	const run = () => {
		const rows = state.users.filter((row) => matches(row, condition));
		if (!changes) return rows;
		for (const row of rows) Object.assign(row, changes);
		return undefined;
	};
	const builder = {
		select: () => builder,
		from: () => builder,
		innerJoin: () => builder,
		where: (next: unknown) => {
			condition = next;
			return Object.assign(Promise.resolve().then(run), {
				limit: async () => run(),
			});
		},
		update: () => builder,
		set: (values: Record<string, unknown>) => {
			changes = Object.fromEntries(
				Object.entries(values).filter(([, value]) => value !== undefined),
			);
			state.updates.push(values);
			return builder;
		},
		insert: () => builder,
		values: async (values: Row) => {
			state.inserts.push(values);
			state.users.push({ ...values, stripeSubscriptionId: null });
		},
	};
	return builder;
};

vi.mock("@cap/database", () => ({ db: () => query() }));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "guest-user" }));
vi.mock("@cap/database/loops/queue", () => ({ enqueueLoopsSync: vi.fn() }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/payment-failed", () => ({
	PaymentFailed: vi.fn(),
}));
vi.mock("@cap/database/schema", () => ({
	developerCreditTransactions: {},
	signedBaas: {},
	users: { id: "id", email: "email" },
}));
vi.mock("@cap/env", () => ({
	buildEnv: {},
	serverEnv: () => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" }),
}));
vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (v: string) => v } },
	User: { UserId: { make: (v: string) => v } },
}));
vi.mock("drizzle-orm", () => ({
	and: vi.fn(),
	eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
	inArray: vi.fn(),
	isNull: vi.fn(),
	ne: vi.fn(),
	or: vi.fn(),
	sql: vi.fn(),
}));
vi.mock("@/lib/baa/billing", () => ({
	attachPaidBaaCheckout: vi.fn(),
	ensureBaaHasPro: vi.fn(),
	hasBaaProWaiver: vi.fn(),
	hasPaidBaaInvoice: vi.fn(),
	isSignedBaaPrice: () => false,
	isSignedBaaSubscription: () => false,
}));
vi.mock("@/lib/sso/billing", () => ({
	attachSsoCheckout: vi.fn(),
	getSsoBillingForSubscription: vi.fn(async () => null),
	syncSsoSubscription: vi.fn(),
}));
vi.mock("@/lib/developer-credits", () => ({ addCreditsToAccount: vi.fn() }));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));

const mockStripe = {
	webhooks: { constructEvent: vi.fn() },
	customers: { retrieve: vi.fn(), update: vi.fn() },
	subscriptions: { retrieve: vi.fn(), list: vi.fn() },
};

vi.mock("@cap/utils", () => ({
	stripe: () => mockStripe,
	isProSubscription: () => true,
	isSsoSubscription: () => false,
	isStandaloneScimSubscription: () => false,
}));

const completed = (
	metadata: Record<string, string>,
	{ customer = "cus_1", subscription = "sub_1" } = {},
) => ({
	type: "checkout.session.completed",
	data: {
		object: {
			id: "cs_test_1",
			customer,
			subscription,
			payment_status: "paid",
			metadata,
			customer_details: { email: "paid@example.com" },
		},
	},
});

type FakeSubscription = {
	id: string;
	status: string;
	customer: string;
	metadata: Record<string, string>;
	items: { data: { quantity: number; price: { id: string } }[] };
};

const fakeSubscription = (
	id: string,
	customer: string,
	quantity: number,
	status = "active",
): FakeSubscription => ({
	id,
	status,
	customer,
	metadata: {},
	items: { data: [{ quantity, price: { id: "price_pro" } }] },
});

const subscriptionEvent = (type: string, subscription: FakeSubscription) => ({
	type,
	data: { object: subscription },
});

const stripeSubscriptions = (subscriptions: FakeSubscription[]) => {
	mockStripe.subscriptions.retrieve.mockImplementation(async (id: string) => {
		const subscription = subscriptions.find((sub) => sub.id === id);
		if (!subscription) {
			throw Object.assign(new Error(`No such subscription: '${id}'`), {
				code: "resource_missing",
			});
		}
		return subscription;
	});
	mockStripe.subscriptions.list.mockImplementation(
		async ({ customer }: { customer: string }) => ({
			data: subscriptions.filter((sub) => sub.customer === customer),
		}),
	);
};

const request = () =>
	new Request("https://cap.test/api/webhooks/stripe", {
		method: "POST",
		headers: { "Stripe-Signature": "sig_test" },
		body: "{}",
	});

describe("Stripe webhook: Cap Pro checkout fulfilment", () => {
	let POST: typeof import("@/app/api/webhooks/stripe/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		state.users = [];
		state.updates = [];
		state.inserts = [];
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_1",
			status: "active",
			metadata: {},
			items: { data: [{ quantity: 3, price: { id: "price_pro" } }] },
		});
		mockStripe.customers.update.mockResolvedValue({});
		POST = (await import("@/app/api/webhooks/stripe/route")).POST;
	});

	it("finds a signed-in buyer through the session when the customer no longer points at them", async () => {
		state.users = [
			{ id: "user-1", email: "new@example.com", stripeSubscriptionId: null },
		];
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "old@example.com",
			metadata: {},
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(
			completed({ dubCustomerId: "user-1", checkoutUi: "elements" }),
		);

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(state.updates).toContainEqual(
			expect.objectContaining({
				stripeSubscriptionId: "sub_1",
				stripeSubscriptionStatus: "active",
				stripeCustomerId: "cus_1",
				inviteQuota: 3,
			}),
		);
		expect(mockStripe.customers.update).toHaveBeenCalledWith("cus_1", {
			metadata: { userId: "user-1" },
		});
	});

	it("falls back to the session buyer when the customer's userId is stale", async () => {
		vi.useFakeTimers();
		state.users = [
			{ id: "user-1", email: "new@example.com", stripeSubscriptionId: null },
		];
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "old@example.com",
			metadata: { userId: "deleted-user", source: "app" },
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(
			completed({ dubCustomerId: "user-1" }),
		);

		const pending = POST(request());
		await vi.runAllTimersAsync();
		const response = await pending;
		vi.useRealTimers();

		expect(response.status).toBe(200);
		expect(state.updates).toContainEqual(
			expect.objectContaining({
				stripeSubscriptionId: "sub_1",
				inviteQuota: 3,
			}),
		);
		expect(mockStripe.customers.update).toHaveBeenCalledWith("cus_1", {
			metadata: { userId: "user-1", source: "app" },
		});
	});

	it("leaves the customer alone when its userId already matches", async () => {
		state.users = [
			{ id: "user-1", email: "paid@example.com", stripeSubscriptionId: null },
		];
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "paid@example.com",
			metadata: { userId: "user-1" },
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(
			completed({ dubCustomerId: "user-1" }),
		);

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mockStripe.customers.update).not.toHaveBeenCalled();
		expect(state.updates).toContainEqual(
			expect.objectContaining({ stripeSubscriptionId: "sub_1" }),
		);
	});

	it("creates and links a new account for a guest", async () => {
		vi.useFakeTimers();
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "guest@example.com",
			metadata: {},
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(
			completed({ guestCheckout: "true", checkoutUi: "elements" }),
		);

		const pending = POST(request());
		await vi.runAllTimersAsync();
		const response = await pending;
		vi.useRealTimers();

		expect(response.status).toBe(200);
		expect(state.inserts).toEqual([
			expect.objectContaining({ id: "guest-user", email: "guest@example.com" }),
		]);
		expect(mockStripe.customers.update).toHaveBeenCalledTimes(1);
		expect(mockStripe.customers.update).toHaveBeenCalledWith("cus_1", {
			metadata: { userId: "guest-user" },
		});
		expect(state.updates).toContainEqual(
			expect.objectContaining({
				stripeSubscriptionId: "sub_1",
				inviteQuota: 3,
			}),
		);
	});

	it("gives Pro to the existing account when a guest pays with its email", async () => {
		state.users = [
			{ id: "user-2", email: "guest@example.com", stripeSubscriptionId: null },
		];
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "guest@example.com",
			metadata: {},
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(
			completed({ guestCheckout: "true" }),
		);

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(state.inserts).toEqual([]);
		expect(mockStripe.customers.update).toHaveBeenCalledWith("cus_1", {
			metadata: { userId: "user-2" },
		});
	});
	describe("an account that already has a live subscription", () => {
		const owner = () => ({
			id: "user-own",
			email: "owner@example.com",
			stripeSubscriptionId: "sub_own",
			stripeSubscriptionStatus: "active",
			stripeCustomerId: "cus_own",
			inviteQuota: 5,
		});
		const guestCustomer = {
			id: "cus_guest",
			email: "owner@example.com",
			metadata: {},
		};

		beforeEach(() => {
			state.users = [owner()];
			mockStripe.customers.retrieve.mockResolvedValue(guestCustomer);
		});

		it("keeps its subscription, customer and seats when a guest pays with its email", async () => {
			const guestSubscription = fakeSubscription("sub_guest", "cus_guest", 1);
			stripeSubscriptions([
				fakeSubscription("sub_own", "cus_own", 5),
				guestSubscription,
			]);

			mockStripe.webhooks.constructEvent.mockReturnValue(
				completed(
					{ guestCheckout: "true", checkoutUi: "elements" },
					{ customer: "cus_guest", subscription: "sub_guest" },
				),
			);
			expect((await POST(request())).status).toBe(200);

			mockStripe.webhooks.constructEvent.mockReturnValue(
				subscriptionEvent("customer.subscription.updated", guestSubscription),
			);
			expect((await POST(request())).status).toBe(200);

			stripeSubscriptions([fakeSubscription("sub_own", "cus_own", 5)]);
			mockStripe.webhooks.constructEvent.mockReturnValue(
				subscriptionEvent(
					"customer.subscription.deleted",
					fakeSubscription("sub_guest", "cus_guest", 1, "canceled"),
				),
			);
			expect((await POST(request())).status).toBe(200);

			expect(state.users).toEqual([owner()]);
			expect(state.updates).toEqual([]);
			expect(state.inserts).toEqual([]);
			expect(mockStripe.customers.update).not.toHaveBeenCalled();
		});

		it.each([
			[
				"customer.subscription.updated",
				fakeSubscription("sub_guest", "cus_guest", 1, "past_due"),
			],
			[
				"customer.subscription.deleted",
				fakeSubscription("sub_guest", "cus_guest", 1, "canceled"),
			],
		])(
			"ignores %s for a different subscription linked to the account",
			async (type, subscription) => {
				stripeSubscriptions([
					fakeSubscription("sub_own", "cus_own", 5),
					subscription,
				]);
				mockStripe.customers.retrieve.mockResolvedValue({
					...guestCustomer,
					metadata: { userId: "user-own" },
				});
				mockStripe.webhooks.constructEvent.mockReturnValue(
					subscriptionEvent(type, subscription),
				);

				expect((await POST(request())).status).toBe(200);
				expect(state.users).toEqual([owner()]);
				expect(state.updates).toEqual([]);
			},
		);

		it("keeps the tracked subscription when the signed-in owner completes a second checkout", async () => {
			stripeSubscriptions([
				fakeSubscription("sub_own", "cus_own", 5),
				fakeSubscription("sub_second", "cus_own", 2),
			]);
			mockStripe.customers.retrieve.mockResolvedValue({
				id: "cus_own",
				email: "owner@example.com",
				metadata: { userId: "user-own" },
			});
			mockStripe.webhooks.constructEvent.mockReturnValue(
				completed(
					{ dubCustomerId: "user-own", checkoutUi: "elements" },
					{ customer: "cus_own", subscription: "sub_second" },
				),
			);

			expect((await POST(request())).status).toBe(200);
			expect(state.users).toEqual([owner()]);
			expect(state.updates).toEqual([]);
		});

		it("asks Stripe to retry when the current subscription cannot be checked", async () => {
			stripeSubscriptions([fakeSubscription("sub_guest", "cus_guest", 1)]);
			const retrieve =
				mockStripe.subscriptions.retrieve.getMockImplementation();
			mockStripe.subscriptions.retrieve.mockImplementation(
				async (id: string) => {
					if (id === "sub_own") throw new Error("Stripe unavailable");
					return retrieve?.(id);
				},
			);
			mockStripe.webhooks.constructEvent.mockReturnValue(
				completed(
					{ guestCheckout: "true" },
					{ customer: "cus_guest", subscription: "sub_guest" },
				),
			);

			expect((await POST(request())).status).toBe(400);
			expect(state.users).toEqual([owner()]);
			expect(mockStripe.customers.update).not.toHaveBeenCalled();
		});

		it("still applies changes to its own current subscription", async () => {
			const updated = fakeSubscription("sub_own", "cus_own", 7);
			stripeSubscriptions([updated]);
			mockStripe.customers.retrieve.mockResolvedValue({
				id: "cus_own",
				email: "owner@example.com",
				metadata: { userId: "user-own" },
			});
			mockStripe.webhooks.constructEvent.mockReturnValue(
				subscriptionEvent("customer.subscription.updated", updated),
			);

			expect((await POST(request())).status).toBe(200);
			expect(state.users[0]).toMatchObject({
				stripeSubscriptionId: "sub_own",
				stripeCustomerId: "cus_own",
				inviteQuota: 7,
			});

			const canceled = fakeSubscription("sub_own", "cus_own", 7, "canceled");
			stripeSubscriptions([canceled]);
			mockStripe.webhooks.constructEvent.mockReturnValue(
				subscriptionEvent("customer.subscription.deleted", canceled),
			);

			expect((await POST(request())).status).toBe(200);
			expect(state.users[0]).toMatchObject({
				stripeSubscriptionId: "sub_own",
				stripeSubscriptionStatus: "canceled",
				inviteQuota: 1,
			});
		});

		it("moves the account onto the customer's other live subscription when the tracked one is deleted", async () => {
			const canceled = fakeSubscription("sub_own", "cus_own", 5, "canceled");
			stripeSubscriptions([
				canceled,
				fakeSubscription("sub_second", "cus_own", 2, "past_due"),
			]);
			mockStripe.customers.retrieve.mockResolvedValue({
				id: "cus_own",
				email: "owner@example.com",
				metadata: { userId: "user-own" },
			});
			mockStripe.webhooks.constructEvent.mockReturnValue(
				subscriptionEvent("customer.subscription.deleted", canceled),
			);

			expect((await POST(request())).status).toBe(200);
			expect(state.users[0]).toMatchObject({
				stripeSubscriptionId: "sub_second",
				stripeSubscriptionStatus: "past_due",
				stripeCustomerId: "cus_own",
				inviteQuota: 2,
			});
		});

		it.each([
			[
				"has been canceled",
				[fakeSubscription("sub_own", "cus_own", 5, "canceled")],
			],
			["no longer exists", []],
		])(
			"gives Pro to the account from a guest purchase once its subscription %s",
			async (_, ownSubscriptions) => {
				stripeSubscriptions([
					...ownSubscriptions,
					fakeSubscription("sub_guest", "cus_guest", 2),
				]);
				mockStripe.webhooks.constructEvent.mockReturnValue(
					completed(
						{ guestCheckout: "true" },
						{ customer: "cus_guest", subscription: "sub_guest" },
					),
				);

				expect((await POST(request())).status).toBe(200);
				expect(state.inserts).toEqual([]);
				expect(state.users[0]).toMatchObject({
					stripeSubscriptionId: "sub_guest",
					stripeSubscriptionStatus: "active",
					stripeCustomerId: "cus_guest",
					inviteQuota: 2,
				});
				expect(mockStripe.customers.update).toHaveBeenCalledWith("cus_guest", {
					metadata: { userId: "user-own" },
				});
			},
		);
	});

	it("records onboarding completion for a signed-in onboarding checkout", async () => {
		state.users = [
			{ id: "user-1", email: "paid@example.com", stripeSubscriptionId: null },
		];
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "paid@example.com",
			metadata: { userId: "user-1" },
		});
		mockStripe.webhooks.constructEvent.mockReturnValue(
			completed({ dubCustomerId: "user-1", isOnBoarding: "true" }),
		);

		expect((await POST(request())).status).toBe(200);
		expect(state.users[0]).toMatchObject({
			stripeSubscriptionId: "sub_1",
			stripeCustomerId: "cus_1",
			inviteQuota: 3,
		});
		expect(state.users[0]?.onboarding_completed_at).toBeInstanceOf(Date);
	});
});
