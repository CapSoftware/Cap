import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: Record<string, unknown>[] = [];

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {
	select: vi.fn(),
	from: vi.fn(),
	innerJoin: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
};

const stripeClient = {
	webhooks: { constructEvent: vi.fn() },
	customers: { retrieve: vi.fn(), update: vi.fn() },
	subscriptions: { list: vi.fn(), retrieve: vi.fn() },
};

vi.mock("@cap/database", () => ({ db: () => mockDbChain }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/payment-failed", () => ({ PaymentFailed: vi.fn() }));
vi.mock("@cap/database/helpers", () => ({ nanoId: vi.fn(() => "id") }));
vi.mock("@cap/database/loops/queue", () => ({ enqueueLoopsSync: vi.fn() }));
vi.mock("@cap/database/schema", () => ({
	developerCreditTransactions: {},
	signedBaas: {},
	users: { id: "id", email: "email" },
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" }),
}));
vi.mock("@cap/utils", () => ({
	isProSubscription: () => true,
	isSsoSubscription: () => false,
	isStandaloneScimSubscription: () => false,
	stripe: () => stripeClient,
}));
vi.mock("@cap/web-domain", () => ({
	Organisation: {},
	User: { UserId: { make: (id: string) => id } },
}));
vi.mock("drizzle-orm", () => ({
	and: vi.fn(),
	eq: vi.fn(),
	inArray: vi.fn(),
	isNull: vi.fn(),
	ne: vi.fn(),
	or: vi.fn(),
	sql: vi.fn(),
}));
vi.mock("next/server", () => ({
	NextResponse: { json: (body: unknown) => Response.json(body) },
}));
vi.mock("@/lib/baa/billing", () => ({
	attachPaidBaaCheckout: vi.fn(),
	ensureBaaHasPro: vi.fn(),
	hasBaaProWaiver: vi.fn(),
	hasPaidBaaInvoice: vi.fn(),
	isSignedBaaPrice: vi.fn(),
	isSignedBaaSubscription: () => false,
}));
vi.mock("@/lib/checkout/cap-friday", () => ({
	CAP_FRIDAY_METADATA: {},
	grantCapFridayCredit: vi.fn(),
	reverseCapFridayCredit: vi.fn(),
}));
vi.mock("@/lib/checkout/customer-us-ein", () => ({
	syncCustomerUsEin: vi.fn(),
	US_EIN_METADATA_KEY: "us_ein",
}));
vi.mock("@/lib/developer-credits", () => ({ addCreditsToAccount: vi.fn() }));
vi.mock("@/lib/infra-auto-top-up", () => ({
	saveCardFromCheckout: vi.fn(),
	settleAutoTopUpPaymentIntent: vi.fn(),
}));
vi.mock("@/lib/infra-credit-code", () => ({ isFreeCreditCheckout: vi.fn() }));
vi.mock("@/lib/infra-credit-reversal", () => ({
	awaitsCreditGrant: vi.fn(),
	reverseDisputedPayment: vi.fn(),
	reverseRefundedCharge: vi.fn(),
}));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/sso/billing", () => ({
	attachSsoCheckout: vi.fn(),
	getSsoBillingForSubscription: vi.fn(),
	syncSsoSubscription: vi.fn(),
}));

const subscription = (status: string) => ({
	id: "sub_1",
	status,
	customer: "cus_1",
	items: { data: [{ quantity: 1 }] },
});

describe("customer.subscription.updated webhook", () => {
	beforeEach(() => {
		updates.length = 0;
		vi.clearAllMocks();
		mockDbChain.select.mockReturnValue(mockDbChain);
		mockDbChain.from.mockReturnValue(mockDbChain);
		mockDbChain.innerJoin.mockReturnValue(mockDbChain);
		mockDbChain.where.mockReturnValue(mockDbChain);
		mockDbChain.limit.mockResolvedValue([
			{ id: "user_1", email: "a@b.c", stripeSubscriptionId: "sub_1" },
		]);
		mockDbChain.update.mockReturnValue(mockDbChain);
		mockDbChain.set.mockImplementation((values: Record<string, unknown>) => {
			updates.push(values);
			return mockDbChain;
		});
		stripeClient.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			email: "a@b.c",
			metadata: { userId: "user_1" },
		});
	});

	it("saves the status Stripe reports now, not the status in an older event", async () => {
		// An old `active` update arrives after the subscription was cancelled.
		stripeClient.webhooks.constructEvent.mockReturnValue({
			id: "evt_old",
			type: "customer.subscription.updated",
			data: { object: subscription("active") },
		});
		stripeClient.subscriptions.list.mockResolvedValue({
			data: [subscription("canceled")],
		});

		const { POST } = await import("@/app/api/webhooks/stripe/route");
		await POST(
			new Request("http://localhost/api/webhooks/stripe", {
				method: "POST",
				headers: { "Stripe-Signature": "sig" },
				body: "{}",
			}),
		);

		const write = updates.find((u) => "stripeSubscriptionStatus" in u);
		expect(write?.stripeSubscriptionStatus).toBe("canceled");
	});
});
