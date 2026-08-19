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
});
