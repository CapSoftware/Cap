import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; email: string; stripeSubscriptionId: string | null };

const state = {
	users: [] as Row[],
	lastWhere: undefined as unknown,
	updates: [] as Record<string, unknown>[],
	inserts: [] as Record<string, unknown>[],
};

const matches = (row: Row, condition: unknown) => {
	const [field, value] = (condition as { eq: [string, string] }).eq;
	return row[field as keyof Row] === value;
};

const mockDbChain = {
	select: vi.fn(() => mockDbChain),
	from: vi.fn(() => mockDbChain),
	where: vi.fn((condition: unknown) => {
		state.lastWhere = condition;
		return mockDbChain;
	}),
	limit: vi.fn(async () =>
		state.users.filter((row) => matches(row, state.lastWhere)),
	),
	update: vi.fn(() => mockDbChain),
	set: vi.fn((values: Record<string, unknown>) => {
		state.updates.push(values);
		return mockDbChain;
	}),
	insert: vi.fn(() => mockDbChain),
	values: vi.fn(async (values: Row) => {
		state.inserts.push(values);
		state.users.push({ ...values, stripeSubscriptionId: null });
	}),
};

vi.mock("@cap/database", () => ({ db: () => mockDbChain }));
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
}));

const completed = (metadata: Record<string, string>) => ({
	type: "checkout.session.completed",
	data: {
		object: {
			id: "cs_test_1",
			customer: "cus_1",
			subscription: "sub_1",
			payment_status: "paid",
			metadata,
			customer_details: { email: "paid@example.com" },
		},
	},
});

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
});
