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

vi.mock("@cap/database/schema", () => ({
	developerCreditTransactions: {
		id: "id",
		accountId: "accountId",
		referenceId: "referenceId",
		referenceType: "referenceType",
	},
	users: { id: "id", email: "email" },
}));

vi.mock("@cap/env", () => ({
	buildEnv: {
		NEXT_PUBLIC_POSTHOG_KEY: "",
		NEXT_PUBLIC_POSTHOG_HOST: "",
	},
	serverEnv: () => ({
		STRIPE_WEBHOOK_SECRET: "whsec_test",
	}),
}));

const mockAddCredits = vi.fn();
vi.mock("@/actions/developers/purchase-credits", () => ({
	addCreditsToAccount: (...args: unknown[]) => mockAddCredits(...args),
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
	},
};

vi.mock("@cap/utils", () => ({
	stripe: () => mockStripe,
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("posthog-node", () => ({
	PostHog: vi.fn().mockImplementation(() => ({
		capture: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
	})),
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

function makeCheckoutSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "cs_test_123",
		customer: "cus_test",
		subscription: null,
		payment_intent: "pi_test_abc",
		metadata: {
			type: "developer_credits",
			appId: "app-456",
			accountId: "account-001",
			amountCents: "2500",
			userId: "user-123",
		},
		customer_details: { email: "test@example.com" },
		...overrides,
	};
}

describe("Stripe webhook — developer credits", () => {
	let POST: typeof import("@/app/api/webhooks/stripe/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetDbChain();
		mockAddCredits.mockResolvedValue(250000);
		const mod = await import("@/app/api/webhooks/stripe/route");
		POST = mod.POST;
	});

	it("returns 400 when signature is missing", async () => {
		const req = new Request("https://cap.test/api/webhooks/stripe", {
			method: "POST",
			body: "{}",
		});
		const res = await POST(req);
		expect(res.status).toBe(400);
	});

	it("returns 400 when constructEvent throws", async () => {
		mockStripe.webhooks.constructEvent.mockImplementation(() => {
			throw new Error("Invalid signature");
		});
		const res = await POST(makeWebhookRequest());
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toContain("Invalid signature");
	});

	it("adds credits on valid developer_credits checkout", async () => {
		const session = makeCheckoutSession();
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});
		mockDbChain.limit.mockResolvedValueOnce([]);

		const res = await POST(makeWebhookRequest());
		expect(res.status).toBe(200);
		expect(mockAddCredits).toHaveBeenCalledWith({
			accountId: "account-001",
			amountCents: 2500,
			referenceId: "pi_test_abc",
			referenceType: "stripe_payment_intent",
			metadata: {
				amountCents: 2500,
				stripeSessionId: "cs_test_123",
			},
		});
	});

	it("converts amountCents from string to number", async () => {
		const session = makeCheckoutSession({
			metadata: {
				type: "developer_credits",
				appId: "app-456",
				accountId: "account-001",
				amountCents: "5000",
				userId: "user-123",
			},
		});
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});
		mockDbChain.limit.mockResolvedValueOnce([]);

		await POST(makeWebhookRequest());
		expect(mockAddCredits).toHaveBeenCalledWith(
			expect.objectContaining({ amountCents: 5000 }),
		);
	});

	it("skips duplicate webhook delivery (idempotency)", async () => {
		const session = makeCheckoutSession();
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});
		mockDbChain.limit.mockResolvedValueOnce([{ id: "existing-txn-id" }]);

		const res = await POST(makeWebhookRequest());
		expect(res.status).toBe(200);
		expect(mockAddCredits).not.toHaveBeenCalled();
	});

	it("returns 400 when payment_intent is missing", async () => {
		const session = makeCheckoutSession({ payment_intent: null });
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});

		const res = await POST(makeWebhookRequest());
		expect(res.status).toBe(400);
		expect(mockAddCredits).not.toHaveBeenCalled();
	});

	it("returns 400 when accountId is missing from metadata", async () => {
		const session = makeCheckoutSession({
			metadata: {
				type: "developer_credits",
				amountCents: "1000",
				userId: "user-123",
			},
		});
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});

		const res = await POST(makeWebhookRequest());
		expect(res.status).toBe(400);
		expect(mockAddCredits).not.toHaveBeenCalled();
	});

	it("returns 400 when amountCents is missing from metadata", async () => {
		const session = makeCheckoutSession({
			metadata: {
				type: "developer_credits",
				accountId: "account-001",
				userId: "user-123",
			},
		});
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});

		const res = await POST(makeWebhookRequest());
		expect(res.status).toBe(400);
		expect(mockAddCredits).not.toHaveBeenCalled();
	});

	it("does not fall through to subscription logic for developer_credits", async () => {
		const session = makeCheckoutSession();
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});
		mockDbChain.limit.mockResolvedValueOnce([]);

		await POST(makeWebhookRequest());
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
		expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
	});
});
