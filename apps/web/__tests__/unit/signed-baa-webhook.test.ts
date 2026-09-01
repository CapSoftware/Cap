import { sendEmail } from "@cap/database/emails/config";
import { signedBaas, users } from "@cap/database/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbChain = {
	select: vi.fn(),
	from: vi.fn(),
	innerJoin: vi.fn(),
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
		fn.mockReset();
	}
	mockDbChain.select.mockReturnValue(mockDbChain);
	mockDbChain.from.mockReturnValue(mockDbChain);
	mockDbChain.innerJoin.mockReturnValue(mockDbChain);
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
		userId: "signedBaaUserId",
		signedAt: "signedBaaSignedAt",
		updatedAt: "signedBaaUpdatedAt",
	},
	users: {
		id: "id",
		email: "email",
		stripeCustomerId: "stripeCustomerId",
		stripeSubscriptionId: "stripeSubscriptionId",
	},
	organizations: { id: "organizationId", ownerId: "ownerId" },
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
	STRIPE_SIGNED_BAA_PRICE_IDS: {
		production: "price_baa",
		development: "price_baa_test",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
	inArray: vi.fn((a: unknown, b: unknown[]) => ({ inArray: [a, b] })),
	isNull: vi.fn((a: unknown) => ({ isNull: a })),
	ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
	sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({
		parts: [...parts],
		values,
	}),
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
	const directOwner = {
		stripeCustomerId: "cus_pro",
		stripeSubscriptionId: "sub_pro",
	};
	const directProSubscription = {
		id: "sub_pro",
		customer: "cus_pro",
		status: "active",
		metadata: {},
		items: { data: [{ price: { id: "price_pro" } }] },
	};

	function mockDirectBaaRecovery(
		subscription: Record<string, unknown>,
		proStatus = "active",
	) {
		mockStripe.subscriptions.retrieve.mockImplementation(async (id: string) =>
			id === "sub_pro"
				? { ...directProSubscription, status: proStatus }
				: subscription,
		);
		mockDbChain.limit
			.mockResolvedValueOnce([
				{
					id: "baa-1",
					userId: "user-1",
					organizationId: "org-1",
					status: "processing",
					stripeSubscriptionId: subscription.id,
					signedAt: null,
				},
			])
			.mockResolvedValueOnce([directOwner]);
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		resetDbChain();
		const mod = await import("@/app/api/webhooks/stripe/route");
		POST = mod.POST;
	});

	it("attaches an entitled BAA subscription to a row missing the Stripe ID", async () => {
		const subscription = {
			id: "sub_baa_1",
			status: "active",
			metadata: { type: "signed_baa", organizationId: "org-1" },
			latest_invoice: { status: "paid" },
		};
		mockDirectBaaRecovery(subscription);
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
			stripeSubscriptionId: "sub_baa_1",
			updatedAt: expect.any(Object),
		});
		expect(mockDbChain.set).toHaveBeenCalledWith({
			status: expect.objectContaining({
				values: expect.arrayContaining(["paid"]),
			}),
			stripeSubscriptionId: "sub_baa_1",
			updatedAt: expect.any(Object),
		});
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
	});

	it("associates the BAA subscription from its creation event", async () => {
		const subscription = {
			id: "sub_baa_new",
			status: "active",
			metadata: { type: "signed_baa", organizationId: "org-1" },
			latest_invoice: { status: "paid" },
		};
		mockDirectBaaRecovery(subscription);
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
			stripeSubscriptionId: "sub_baa_new",
			updatedAt: expect.any(Object),
		});
		expect(mockDbChain.set).toHaveBeenCalledWith({
			status: expect.objectContaining({
				values: expect.arrayContaining(["paid"]),
			}),
			stripeSubscriptionId: "sub_baa_new",
			updatedAt: expect.any(Object),
		});
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
	});

	it("cancels a recovered BAA when Pro ended before its creation event", async () => {
		const subscription = {
			id: "sub_baa_lost_response",
			status: "active",
			metadata: {
				type: "signed_baa",
				organizationId: "org-1",
				userId: "user-1",
			},
			latest_invoice: { status: "paid" },
		};
		mockDirectBaaRecovery(subscription, "canceled");
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.created",
			data: { object: subscription },
		});

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(200);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
			"sub_baa_lost_response",
		);
		expect(mockDbChain.set).toHaveBeenCalledWith({ status: "canceled" });
		expect(mockDbChain.set).toHaveBeenCalledTimes(2);
	});

	it("retries recovered BAA association when its owner is missing", async () => {
		const subscription = {
			id: "sub_baa_missing_owner",
			status: "active",
			metadata: { type: "signed_baa", organizationId: "org-1" },
			latest_invoice: { status: "paid" },
		};
		mockStripe.subscriptions.retrieve.mockResolvedValue(subscription);
		mockDbChain.limit
			.mockResolvedValueOnce([
				{
					id: "baa-1",
					userId: "missing-user",
					organizationId: "org-1",
					status: "processing",
					stripeSubscriptionId: subscription.id,
					signedAt: null,
				},
			])
			.mockResolvedValueOnce([]);
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.created",
			data: { object: subscription },
		});

		const res = await POST(makeWebhookRequest());

		expect(res.status).toBe(400);
		expect(mockDbChain.set).toHaveBeenCalledTimes(1);
		expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
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

describe("Signed BAA Payment Link webhooks", () => {
	let POST: typeof import("@/app/api/webhooks/stripe/route").POST;
	const subscription = {
		id: "sub_link_baa",
		customer: "cus_link",
		status: "active",
		metadata: {},
		items: { data: [{ price: { id: "price_baa" }, quantity: 1 }] },
		latest_invoice: { status: "paid" },
	};
	const session = {
		id: "cs_link_baa",
		mode: "subscription",
		status: "complete",
		payment_status: "paid",
		customer: "cus_link",
		customer_details: { email: "owner@example.com" },
		subscription: "sub_link_baa",
		metadata: {},
	};
	const owner = {
		id: "user-1",
		email: "owner@example.com",
		stripeCustomerId: "cus_pro",
		stripeSubscriptionId: "sub_pro",
	};
	const proSubscription = {
		id: "sub_pro",
		customer: "cus_pro",
		status: "active",
		metadata: {},
		items: { data: [{ price: { id: "price_pro" }, quantity: 1 }] },
	};
	const pending = {
		id: "baa-1",
		userId: "user-1",
		organizationId: "org-1",
		status: "pending",
		stripeSubscriptionId: null,
		signedAt: null,
	};
	const paid = {
		...pending,
		status: "paid",
		stripeSubscriptionId: "sub_link_baa",
	};
	const waivedSubscription = {
		...subscription,
		metadata: {
			proRequirement: "waived",
			baaRecordId: paid.id,
			organizationId: paid.organizationId,
			userId: paid.userId,
		},
	};
	const legacyOwner = {
		...owner,
		stripeSubscriptionId: "12345",
		stripeSubscriptionStatus: "active",
		inviteQuota: 6,
	};
	const linkedRecord = {
		id: paid.id,
		organizationId: paid.organizationId,
		userId: paid.userId,
		subscriptionId: subscription.id,
	};

	function mockWaivedSubscription(value = waivedSubscription) {
		mockStripe.subscriptions.retrieve.mockImplementation(async (id: string) => {
			if (id === value.id) return value;
			throw new Error(`No such subscription: ${id}`);
		});
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		resetDbChain();
		mockStripe.subscriptions.retrieve
			.mockReset()
			.mockImplementation(async (id: string) =>
				id === "sub_pro" ? proSubscription : subscription,
			);
		mockStripe.subscriptions.cancel
			.mockReset()
			.mockResolvedValue({ id: "sub_link_baa", status: "canceled" });
		POST = (await import("@/app/api/webhooks/stripe/route")).POST;
	});

	it.each([
		"checkout.session.completed",
		"checkout.session.async_payment_succeeded",
	])("attaches %s without overwriting Pro billing", async (eventType) => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: eventType,
			data: { object: session },
		});
		mockDbChain.limit
			.mockResolvedValueOnce([owner])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([pending])
			.mockResolvedValueOnce([{ ownerId: owner.id }])
			.mockResolvedValueOnce([{ ...paid, status: "pending" }])
			.mockResolvedValueOnce([paid]);
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.update).toHaveBeenCalledWith(signedBaas);
		expect(mockDbChain.set).toHaveBeenCalledWith({
			stripeSubscriptionId: "sub_link_baa",
		});
		expect(mockDbChain.set).toHaveBeenCalledWith({ status: "paid" });
		expect(mockDbChain.update).not.toHaveBeenCalledWith(users);
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("reconciles a waived paid checkout without retrieving or changing legacy Pro", async () => {
		mockWaivedSubscription();
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});
		mockDbChain.limit
			.mockResolvedValueOnce([legacyOwner])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([pending])
			.mockResolvedValueOnce([{ ownerId: owner.id }])
			.mockResolvedValueOnce([{ ...paid, status: "pending" }])
			.mockResolvedValueOnce([paid]);
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.set).toHaveBeenCalledWith({ status: "paid" });
		expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalledWith("12345");
		expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
		expect(mockDbChain.update).not.toHaveBeenCalledWith(users);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it.each(["paid", "active"])(
		"preserves a %s waived BAA through subscription lifecycle updates",
		async (status) => {
			mockWaivedSubscription();
			mockStripe.webhooks.constructEvent.mockReturnValue({
				type: "customer.subscription.updated",
				data: { object: waivedSubscription },
			});
			mockDbChain.limit
				.mockResolvedValueOnce([
					{
						...paid,
						status,
						signedAt: status === "active" ? new Date() : null,
					},
				])
				.mockResolvedValueOnce([legacyOwner]);
			expect((await POST(makeWebhookRequest())).status).toBe(200);
			expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalledWith(
				"12345",
			);
			expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
			expect(mockDbChain.set).not.toHaveBeenCalledWith(
				expect.objectContaining({ status: "canceled" }),
			);
			expect(mockDbChain.update).not.toHaveBeenCalledWith(users);
			expect(sendEmail).not.toHaveBeenCalled();
		},
	);

	it.each(["canceled", "unpaid"])(
		"honors a waived BAA's current %s state over a stale active event",
		async (status) => {
			mockWaivedSubscription({ ...waivedSubscription, status });
			mockStripe.webhooks.constructEvent.mockReturnValue({
				type: "customer.subscription.updated",
				data: { object: waivedSubscription },
			});
			expect((await POST(makeWebhookRequest())).status).toBe(200);
			expect(mockDbChain.set).toHaveBeenCalledWith(
				expect.objectContaining({ status: "canceled" }),
			);
			expect(mockDbChain.update).not.toHaveBeenCalledWith(users);
		},
	);

	it("acknowledges an unpaid BAA checkout without granting payment or Pro", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: { ...session, payment_status: "unpaid" } },
		});
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.update).not.toHaveBeenCalled();
	});

	it.each(["canceled", "unpaid"])(
		"cancels delayed paid checkout when Pro is already %s",
		async (status) => {
			mockStripe.webhooks.constructEvent.mockReturnValue({
				type: "checkout.session.completed",
				data: { object: session },
			});
			mockStripe.subscriptions.retrieve.mockImplementation(
				async (id: string) =>
					id === "sub_pro" ? { ...proSubscription, status } : subscription,
			);
			mockDbChain.limit
				.mockResolvedValueOnce([owner])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([pending])
				.mockResolvedValueOnce([{ ownerId: owner.id }])
				.mockResolvedValueOnce([{ ...paid, status: "pending" }]);
			expect((await POST(makeWebhookRequest())).status).toBe(200);
			expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
				"sub_link_baa",
			);
			expect(mockDbChain.set).toHaveBeenCalledWith({ status: "canceled" });
			expect(mockDbChain.set).not.toHaveBeenCalledWith({ status: "paid" });
			expect(mockDbChain.update).not.toHaveBeenCalledWith(users);
		},
	);

	it("is idempotent after the same subscription has already been attached", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});
		mockDbChain.limit
			.mockResolvedValueOnce([owner])
			.mockResolvedValueOnce([paid])
			.mockResolvedValueOnce([{ ownerId: owner.id }]);
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.update).not.toHaveBeenCalled();
	});

	it("cancels a second checkout while preserving the existing paid BAA and Pro", async () => {
		const previous = { ...paid, stripeSubscriptionId: "sub_existing" };
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: { object: session },
		});
		mockDbChain.limit
			.mockResolvedValueOnce([owner])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([previous])
			.mockResolvedValueOnce([{ ownerId: owner.id }]);
		mockStripe.subscriptions.retrieve.mockImplementation(
			async (id: string) => ({ ...subscription, id }),
		);
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
			"sub_link_baa",
		);
		expect(mockDbChain.update).not.toHaveBeenCalled();
	});

	it("recognizes price-only BAA subscription updates before Pro handling", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: { object: subscription },
		});
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.update).toHaveBeenCalledWith(signedBaas);
		expect(mockDbChain.update).not.toHaveBeenCalledWith(users);
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
	});

	it("uses current cancellation state instead of a stale active event", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: {
				object: {
					...subscription,
					metadata: { type: "signed_baa", organizationId: "org-1" },
				},
			},
		});
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			...subscription,
			status: "canceled",
			metadata: { type: "signed_baa", organizationId: "org-1" },
		});
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "canceled" }),
		);
		expect(mockDbChain.where).toHaveBeenCalledWith([
			{ eq: ["signedBaaStripeSubscriptionId", "sub_link_baa"] },
		]);
	});

	it("does not send Pro payment failure emails for a price-only BAA invoice", async () => {
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "invoice.payment_failed",
			data: {
				object: {
					id: "in_baa",
					billing_reason: "subscription_cycle",
					attempt_count: 1,
					next_payment_attempt: null,
					lines: { data: [{ price: { id: "price_baa" } }] },
				},
			},
		});
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
	});

	it("cancels the BAA on its separate customer when Pro becomes unpaid", async () => {
		const pro = {
			id: "sub_pro",
			status: "unpaid",
			customer: "cus_pro",
			metadata: {},
			items: { data: [{ price: { id: "price_pro" }, quantity: 3 }] },
		};
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: { object: pro },
		});
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_pro",
			email: owner.email,
			metadata: { userId: owner.id },
		});
		mockStripe.subscriptions.list.mockResolvedValue({ data: [pro] });
		mockDbChain.limit
			.mockResolvedValueOnce([owner])
			.mockResolvedValueOnce([linkedRecord]);
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
			"sub_link_baa",
		);
		expect(mockDbChain.set).toHaveBeenCalledWith({ status: "canceled" });
	});

	it.each(["customer.subscription.updated", "customer.subscription.deleted"])(
		"preserves a bound waived BAA during %s Pro cleanup",
		async (eventType) => {
			const pro = {
				...proSubscription,
				status: eventType.endsWith("deleted") ? "canceled" : "unpaid",
			};
			mockWaivedSubscription();
			mockStripe.webhooks.constructEvent.mockReturnValue({
				type: eventType,
				data: { object: pro },
			});
			mockStripe.customers.retrieve.mockResolvedValue({
				id: "cus_pro",
				email: owner.email,
				metadata: { userId: owner.id },
			});
			mockStripe.subscriptions.list.mockResolvedValue({ data: [pro] });
			if (eventType.endsWith("deleted")) {
				mockDbChain.limit.mockResolvedValueOnce([linkedRecord]);
				mockDbChain.where
					.mockReturnValueOnce(mockDbChain)
					.mockResolvedValueOnce([owner]);
			} else {
				mockDbChain.limit
					.mockResolvedValueOnce([owner])
					.mockResolvedValueOnce([linkedRecord]);
			}
			expect((await POST(makeWebhookRequest())).status).toBe(200);
			expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
			expect(mockDbChain.update).not.toHaveBeenCalledWith(signedBaas);
		},
	);

	it.each(["mismatched record", "missing record"])(
		"does not waive Pro cleanup for a BAA with a %s",
		async (binding) => {
			const pro = { ...proSubscription, status: "unpaid" };
			mockWaivedSubscription();
			mockStripe.webhooks.constructEvent.mockReturnValue({
				type: "customer.subscription.updated",
				data: { object: pro },
			});
			mockStripe.customers.retrieve.mockResolvedValue({
				id: "cus_pro",
				email: owner.email,
				metadata: { userId: owner.id },
			});
			mockStripe.subscriptions.list.mockResolvedValue({
				data: [pro, waivedSubscription],
			});
			mockDbChain.limit
				.mockResolvedValueOnce([owner])
				.mockResolvedValueOnce(
					binding === "missing record"
						? []
						: [{ ...linkedRecord, id: "different-baa-record" }],
				);
			expect((await POST(makeWebhookRequest())).status).toBe(200);
			expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
				subscription.id,
			);
			expect(mockDbChain.set).toHaveBeenCalledWith({ status: "canceled" });
		},
	);

	it("resolves a bound waiver on an alternate customer while canceling ordinary BAAs", async () => {
		const pro = { ...proSubscription, status: "unpaid", customer: "cus_link" };
		const ordinaryBaa = { ...subscription, id: "sub_ordinary_baa" };
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "customer.subscription.updated",
			data: { object: pro },
		});
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_link",
			email: owner.email,
			metadata: { userId: owner.id },
		});
		mockStripe.subscriptions.list.mockResolvedValue({
			data: [pro, waivedSubscription, ordinaryBaa],
		});
		mockDbChain.limit
			.mockResolvedValueOnce([owner])
			.mockResolvedValueOnce([linkedRecord]);
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.where).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.arrayContaining([
					{
						inArray: [signedBaas.stripeSubscriptionId, [subscription.id]],
					},
				]),
			]),
		);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
			ordinaryBaa.id,
		);
		expect(mockDbChain.where).not.toHaveBeenCalledWith({
			eq: [signedBaas.stripeSubscriptionId, waivedSubscription.id],
		});
	});

	it("preserves ordinary Pro checkout and its seat quota", async () => {
		const pro = {
			id: "sub_pro",
			status: "active",
			customer: "cus_pro",
			metadata: {},
			items: { data: [{ price: { id: "price_pro" }, quantity: 3 }] },
		};
		mockStripe.webhooks.constructEvent.mockReturnValue({
			type: "checkout.session.completed",
			data: {
				object: { ...session, subscription: "sub_pro", customer: "cus_pro" },
			},
		});
		mockStripe.subscriptions.retrieve.mockResolvedValue(pro);
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_pro",
			email: owner.email,
			metadata: { userId: owner.id },
		});
		mockDbChain.limit.mockResolvedValueOnce([owner]);
		expect((await POST(makeWebhookRequest())).status).toBe(200);
		expect(mockDbChain.update).toHaveBeenCalledWith(users);
		expect(mockDbChain.set).toHaveBeenCalledWith(
			expect.objectContaining({
				stripeSubscriptionId: "sub_pro",
				stripeCustomerId: "cus_pro",
				inviteQuota: 3,
			}),
		);
		expect(mockDbChain.update).not.toHaveBeenCalledWith(signedBaas);
	});
});
