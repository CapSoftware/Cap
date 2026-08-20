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

function resetDbChain() {
	for (const key of Object.keys(mockDbChain)) {
		const fn = mockDbChain[key as keyof typeof mockDbChain];
		fn.mockClear();
	}
	mockDbChain.select.mockReturnValue(mockDbChain);
	mockDbChain.from.mockReturnValue(mockDbChain);
	mockDbChain.where.mockReturnValue(mockDbChain);
	mockDbChain.limit.mockReturnValue(Promise.resolve([]));
	mockDbChain.insert.mockReturnValue(mockDbChain);
	mockDbChain.update.mockReturnValue(mockDbChain);
	mockDbChain.set.mockReturnValue(mockDbChain);
	mockDbChain.values.mockReturnValue(Promise.resolve());
}

vi.mock("@cap/database", () => ({
	db: () => mockDbChain,
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "test-nano-id"),
}));

vi.mock("@cap/database/emails/config", () => ({
	sendEmail: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	developerCreditTransactions: {
		id: "id",
		accountId: "accountId",
		referenceId: "referenceId",
		referenceType: "referenceType",
	},
	signedBaas: {
		id: "signedBaaId",
		organizationId: "signedBaaOrganizationId",
		stripeSubscriptionId: "signedBaaStripeSubscriptionId",
		status: "signedBaaStatus",
	},
	users: { id: "id", email: "email" },
}));

vi.mock("@cap/env", () => ({
	buildEnv: {},
	serverEnv: () => ({
		STRIPE_WEBHOOK_SECRET: "whsec_test",
	}),
}));

vi.mock("@/lib/developer-credits", () => ({
	addCreditsToAccount: vi.fn(),
}));

vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (v: string) => v } },
	User: { UserId: { make: (v: string) => v } },
}));

const mockStripe = {
	webhooks: {
		constructEvent: vi.fn(),
	},
	customers: {
		retrieve: vi.fn(),
	},
	subscriptions: {
		retrieve: vi.fn(),
		list: vi.fn(),
		cancel: vi.fn(),
	},
};

vi.mock("@cap/utils", () => ({
	stripe: () => mockStripe,
	userIsPro: (user?: { stripeSubscriptionStatus?: string | null } | null) =>
		user?.stripeSubscriptionStatus === "active",
	STRIPE_PLAN_IDS: {
		development: {
			yearly: "price_dev_yearly",
			monthly: "price_dev_monthly",
		},
		production: {
			yearly: "price_prod_yearly",
			monthly: "price_prod_monthly",
		},
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
	isNull: vi.fn((a: unknown) => ({ isNull: a })),
	or: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@/lib/server-analytics", () => ({
	trackServerEvent: vi.fn().mockResolvedValue(undefined),
}));

function makeWebhookRequest(body = "{}") {
	return new Request("https://cap.test/api/webhooks/stripe", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Stripe-Signature": "sig_test",
		},
		body,
	});
}

describe("Stripe webhook — Signed BAA", () => {
	let POST: typeof import("@/app/api/webhooks/stripe/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetDbChain();
		const mod = await import("@/app/api/webhooks/stripe/route");
		POST = mod.POST;
	});

	it("attaches an entitled BAA subscription to a row missing the Stripe ID", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: {
				object: {
					id: "sub_baa_1",
					status: "active",
					metadata: {
						type: "signed_baa",
						organizationId: "org-1",
					},
				},
			},
		});

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(mockDbChain.set).toHaveBeenCalledWith({
			status: "active",
			stripeSubscriptionId: "sub_baa_1",
		});
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
	});

	it("associates the BAA subscription from its creation event", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.created",
			data: {
				object: {
					id: "sub_baa_new",
					status: "active",
					metadata: {
						type: "signed_baa",
						organizationId: "org-1",
					},
				},
			},
		});

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(mockDbChain.set).toHaveBeenCalledWith({
			status: "active",
			stripeSubscriptionId: "sub_baa_new",
		});
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
	});

	it("cancels Signed BAA when Pro becomes unpaid", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: {
				object: {
					id: "sub_pro",
					status: "unpaid",
					customer: "cus_1",
					metadata: {},
				},
			},
		});
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "owner@example.com",
			metadata: { userId: "user-1" },
		});
		mockDbChain.limit.mockResolvedValueOnce([
			{ id: "user-1", email: "owner@example.com" },
		]);
		mockStripe.subscriptions.list.mockResolvedValue({
			data: [
				{
					id: "sub_pro",
					status: "unpaid",
					metadata: {},
					items: { data: [{ quantity: 1 }] },
				},
				{
					id: "sub_baa",
					status: "active",
					metadata: { type: "signed_baa" },
					items: { data: [{ quantity: 1 }] },
				},
			],
		});
		mockStripe.subscriptions.cancel.mockResolvedValue({ id: "sub_baa" });

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith("sub_baa");
		expect(mockDbChain.set).toHaveBeenCalledWith({ status: "canceled" });
	});

	it("keeps Signed BAA while Pro is past_due", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: {
				object: {
					id: "sub_pro",
					status: "past_due",
					customer: "cus_1",
					metadata: {},
				},
			},
		});
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "owner@example.com",
			metadata: { userId: "user-1" },
		});
		mockDbChain.limit.mockResolvedValueOnce([
			{ id: "user-1", email: "owner@example.com" },
		]);
		mockStripe.subscriptions.list.mockResolvedValue({
			data: [
				{
					id: "sub_pro",
					status: "past_due",
					metadata: {},
					items: { data: [{ quantity: 1 }] },
				},
				{
					id: "sub_baa",
					status: "active",
					metadata: { type: "signed_baa" },
					items: { data: [{ quantity: 1 }] },
				},
			],
		});

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
	});

	it("cancels Signed BAA even when the customer maps to no user", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: {
				object: {
					id: "sub_pro",
					status: "unpaid",
					customer: "cus_1",
					metadata: {},
				},
			},
		});
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "orphan@example.com",
			metadata: {},
		});
		mockStripe.subscriptions.list.mockResolvedValue({
			data: [
				{
					id: "sub_pro",
					status: "unpaid",
					metadata: {},
					items: { data: [{ quantity: 1 }] },
				},
				{
					id: "sub_baa",
					status: "active",
					metadata: { type: "signed_baa" },
					items: { data: [{ quantity: 1 }] },
				},
			],
		});
		mockStripe.subscriptions.cancel.mockResolvedValue({ id: "sub_baa" });

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(202);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith("sub_baa");
	});

	it("cancels Signed BAA on Pro deletion even without a user mapping", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.deleted",
			data: {
				object: {
					id: "sub_pro",
					status: "canceled",
					customer: "cus_1",
					metadata: {},
				},
			},
		});
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: null,
			metadata: {},
		});
		mockStripe.subscriptions.list.mockResolvedValue({
			data: [
				{
					id: "sub_pro",
					status: "canceled",
					metadata: {},
					items: { data: [{ quantity: 1 }] },
				},
				{
					id: "sub_baa",
					status: "active",
					metadata: { type: "signed_baa" },
					items: { data: [{ quantity: 1 }] },
				},
			],
		});
		mockStripe.subscriptions.cancel.mockResolvedValue({ id: "sub_baa" });

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(400);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith("sub_baa");
	});

	it("fails the webhook when Signed BAA cancellation is rejected", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: {
				object: {
					id: "sub_pro",
					status: "unpaid",
					customer: "cus_1",
					metadata: {},
				},
			},
		});
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "owner@example.com",
			metadata: { userId: "user-1" },
		});
		mockDbChain.limit.mockResolvedValueOnce([
			{ id: "user-1", email: "owner@example.com" },
		]);
		mockStripe.subscriptions.list.mockResolvedValue({
			data: [
				{
					id: "sub_pro",
					status: "unpaid",
					metadata: {},
					items: { data: [{ quantity: 1 }] },
				},
				{
					id: "sub_baa",
					status: "active",
					metadata: { type: "signed_baa" },
					items: { data: [{ quantity: 1 }] },
				},
			],
		});
		mockStripe.subscriptions.cancel.mockRejectedValue(
			new Error("stripe unavailable"),
		);

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(400);
	});
});
