import { getCurrentUser } from "@cap/database/auth/session";
import { sendEmail } from "@cap/database/emails/config";
import { signedBaas } from "@cap/database/schema";
import { STRIPE_SIGNED_BAA_PRICE_IDS } from "@cap/utils";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachPaidBaaCheckout } from "@/lib/baa/billing";
import { generateSignedBaaPdf } from "@/lib/baa/generate-signed-baa-pdf";

const mockDb = {
	select: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
	set: vi.fn(),
	values: vi.fn(),
};

const mockStripe = {
	checkout: { sessions: { retrieve: vi.fn() } },
	subscriptions: {
		retrieve: vi.fn(),
		list: vi.fn(),
		create: vi.fn(),
		cancel: vi.fn(),
	},
	customers: {
		retrieve: vi.fn(),
	},
	paymentMethods: {
		list: vi.fn(),
	},
};

vi.mock("@cap/database", () => ({
	db: () => mockDb,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/emails/config", () => ({
	sendEmail: vi.fn(),
}));

vi.mock("@cap/database/emails/signed-baa", () => ({
	SignedBaa: vi.fn(),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "baa-record-1"),
}));

vi.mock("@cap/database/schema", () => ({
	organizations: {
		id: "organizationId",
		ownerId: "organizationOwnerId",
	},
	signedBaas: {
		id: "signedBaaId",
		organizationId: "signedBaaOrganizationId",
		status: "signedBaaStatus",
		updatedAt: "signedBaaUpdatedAt",
		stripeSubscriptionId: "signedBaaStripeSubscriptionId",
		userId: "signedBaaUserId",
	},
	users: { id: "userId", email: "email", stripeCustomerId: "stripeCustomerId" },
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ VERCEL_ENV: "development" }),
}));

vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return {
		...actual,
		stripe: () => mockStripe,
	};
});

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	lt: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	ne: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	or: vi.fn((...args: unknown[]) => args),
}));

vi.mock("next/cache", () => ({
	revalidatePath: vi.fn(),
}));

vi.mock("@/lib/baa/generate-signed-baa-pdf", () => ({
	formatBaaDate: vi.fn(() => "January 1, 2026"),
	generateSignedBaaPdf: vi.fn(),
}));

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

function resetMockDb() {
	for (const key of Object.keys(mockDb)) {
		const fn = mockDb[key as keyof typeof mockDb];
		fn.mockClear();
	}
	mockDb.select.mockReturnValue(mockDb);
	mockDb.insert.mockReturnValue(mockDb);
	mockDb.update.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.where.mockReturnValue({ ...mockDb, affectedRows: 1 });
	mockDb.set.mockReturnValue(mockDb);
	mockDb.values.mockResolvedValue(undefined);
	mockDb.limit.mockResolvedValue([]);
}

function mockOwner(user: Record<string, unknown>) {
	mockGetCurrentUser.mockResolvedValue({
		id: "owner-1",
		email: "owner@example.com",
		...user,
	});
	mockDb.limit.mockResolvedValueOnce([{ id: "org-1", ownerId: "owner-1" }]);
}

describe("Signed BAA entitlement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetMockDb();
	});

	it("does not treat leftover Stripe IDs as permission to purchase", async () => {
		mockOwner({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_canceled",
			stripeSubscriptionStatus: "canceled",
		});
		mockDb.limit.mockResolvedValueOnce([]);
		const { getSignedBaaStatus } = await import(
			"@/actions/organization/signed-baa"
		);

		const status = await getSignedBaaStatus("org-1" as never);

		expect(status.canPurchase).toBe(false);
	});

	it("allows purchase only while Cap Pro is still entitled", async () => {
		mockOwner({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_active",
			stripeSubscriptionStatus: "active",
		});
		mockDb.limit.mockResolvedValueOnce([]);
		const { getSignedBaaStatus } = await import(
			"@/actions/organization/signed-baa"
		);

		const status = await getSignedBaaStatus("org-1" as never);

		expect(status.canPurchase).toBe(true);
	});

	it("rejects purchase from a former Pro owner", async () => {
		mockOwner({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_canceled",
			stripeSubscriptionStatus: "canceled",
		});
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);

		await expect(
			purchaseSignedBaa("org-1" as never, {
				entityName: "Acme Health, Inc.",
				entityType: "Delaware corporation",
				entityAddress: "123 Main St, San Francisco, CA 94105",
				signerName: "Jane Smith",
				signerTitle: "CEO",
				noticesEmail: "legal@acme.com",
				signatureDataUrl: `data:image/png;base64,${"A".repeat(200)}`,
			}),
		).rejects.toThrow("active Cap Pro subscription");
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("does not treat a leftover third-party subscription id as Cap Pro", async () => {
		mockOwner({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_canceled",
			stripeSubscriptionStatus: "canceled",
			thirdPartyStripeSubscriptionId: "sub_other_org",
		});
		mockDb.limit.mockResolvedValueOnce([]);
		const { getSignedBaaStatus, purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);

		const status = await getSignedBaaStatus("org-1" as never);
		expect(status.canPurchase).toBe(false);

		mockOwner({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_canceled",
			stripeSubscriptionStatus: "canceled",
			thirdPartyStripeSubscriptionId: "sub_other_org",
		});
		await expect(
			purchaseSignedBaa("org-1" as never, {
				entityName: "Acme Health, Inc.",
				entityType: "Delaware corporation",
				entityAddress: "123 Main St, San Francisco, CA 94105",
				signerName: "Jane Smith",
				signerTitle: "CEO",
				noticesEmail: "legal@acme.com",
				signatureDataUrl: `data:image/png;base64,${"A".repeat(200)}`,
			}),
		).rejects.toThrow("active Cap Pro subscription");
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("rejects purchase when Stripe says Cap Pro is no longer entitled", async () => {
		mockOwner({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_stale",
			stripeSubscriptionStatus: "active",
		});
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_stale",
			status: "canceled",
		});
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);

		await expect(
			purchaseSignedBaa("org-1" as never, {
				entityName: "Acme Health, Inc.",
				entityType: "Delaware corporation",
				entityAddress: "123 Main St, San Francisco, CA 94105",
				signerName: "Jane Smith",
				signerTitle: "CEO",
				noticesEmail: "legal@acme.com",
				signatureDataUrl: `data:image/png;base64,${"A".repeat(200)}`,
			}),
		).rejects.toThrow("active Cap Pro subscription");
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
	});
});

const VALID_INPUT = {
	entityName: "Acme Health, Inc.",
	entityType: "Delaware corporation",
	entityAddress: "123 Main St, San Francisco, CA 94105",
	signerName: "Jane Smith",
	signerTitle: "CEO",
	noticesEmail: "legal@acme.com",
	signatureDataUrl: `data:image/png;base64,${"A".repeat(200)}`,
};

const recoveredSubscription = {
	id: "sub_baa_1",
	status: "active",
	metadata: { type: "signed_baa", organizationId: "org-1" },
};

async function setupPurchaseAttempt() {
	mockOwner({
		stripeCustomerId: "cus_1",
		stripeSubscriptionId: "sub_active",
		stripeSubscriptionStatus: "active",
	});
	mockDb.limit.mockResolvedValueOnce([]);
	vi.mocked(generateSignedBaaPdf).mockResolvedValue(new Uint8Array([1, 2, 3]));
	vi.mocked(sendEmail).mockResolvedValue(undefined as never);
	mockStripe.subscriptions.retrieve.mockResolvedValue({
		id: "sub_active",
		customer: "cus_1",
		status: "active",
		default_payment_method: "pm_1",
	});
}

describe("Signed BAA Stripe recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetMockDb();
	});

	it("uses a stable Stripe idempotency key for the record", async () => {
		await setupPurchaseAttempt();
		mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
		mockStripe.subscriptions.create.mockResolvedValue(recoveredSubscription);
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);

		await purchaseSignedBaa("org-1" as never, VALID_INPUT);

		expect(mockStripe.subscriptions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_1",
			}),
			{ idempotencyKey: "signed-baa-baa-record-1" },
		);
	});

	it("activates an existing Stripe subscription after a lost create response", async () => {
		await setupPurchaseAttempt();
		mockStripe.subscriptions.list
			.mockResolvedValueOnce({ data: [] })
			.mockResolvedValueOnce({ data: [recoveredSubscription] });
		mockStripe.subscriptions.create.mockRejectedValueOnce(
			new Error("socket hang up"),
		);
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);

		const result = await purchaseSignedBaa("org-1" as never, VALID_INPUT);

		expect(result.success).toBe(true);
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "active",
				stripeSubscriptionId: "sub_baa_1",
			}),
		);
	});

	it("does not claim the customer was not charged when Stripe is ambiguous", async () => {
		await setupPurchaseAttempt();
		mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
		mockStripe.subscriptions.create.mockRejectedValue(
			new Error("socket hang up"),
		);
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);

		await expect(
			purchaseSignedBaa("org-1" as never, VALID_INPUT),
		).rejects.toThrow("couldn't confirm the Signed BAA subscription");
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending" }),
		);
		expect(mockDb.where).toHaveBeenCalledWith([
			{ field: "signedBaaId", value: "baa-record-1" },
			{ field: "signedBaaStatus", value: "processing" },
			{ field: "signedBaaUpdatedAt", value: expect.any(Date) },
		]);
	});

	it("clears the stale subscription id when re-claiming a canceled record", async () => {
		mockOwner({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_active",
			stripeSubscriptionStatus: "active",
		});
		mockDb.limit.mockResolvedValueOnce([
			{
				id: "baa-record-1",
				status: "canceled",
				stripeSubscriptionId: "sub_old",
				signedAt: null,
				emailSentAt: null,
			},
		]);
		mockDb.where
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce({ affectedRows: 1 });
		vi.mocked(generateSignedBaaPdf).mockResolvedValue(new Uint8Array([1]));
		vi.mocked(sendEmail).mockResolvedValue(undefined as never);
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_active",
			customer: "cus_1",
			status: "active",
			default_payment_method: "pm_1",
		});
		mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
		mockStripe.subscriptions.create.mockResolvedValue(recoveredSubscription);
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);

		const result = await purchaseSignedBaa("org-1" as never, VALID_INPUT);

		expect(result.success).toBe(true);
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "processing",
				stripeSubscriptionId: null,
			}),
		);
	});

	it("cancels a newly purchased BAA if Pro ends while payment is in flight", async () => {
		await setupPurchaseAttempt();
		const pro = {
			id: "sub_active",
			customer: "cus_1",
			status: "active",
			default_payment_method: "pm_1",
		};
		mockStripe.subscriptions.retrieve
			.mockReset()
			.mockResolvedValueOnce(pro)
			.mockResolvedValueOnce(pro)
			.mockResolvedValueOnce({ ...pro, status: "canceled" });
		mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
		mockStripe.subscriptions.create.mockResolvedValue(recoveredSubscription);
		mockStripe.subscriptions.cancel.mockResolvedValue({
			id: recoveredSubscription.id,
			status: "canceled",
		});
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);
		await expect(
			purchaseSignedBaa("org-1" as never, VALID_INPUT),
		).rejects.toThrow("Cap Pro ended");
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith(
			recoveredSubscription.id,
		);
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({
				stripeSubscriptionId: recoveredSubscription.id,
			}),
		);
		expect(mockDb.set).toHaveBeenCalledWith({ status: "canceled" });
		expect(mockDb.set).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "active" }),
		);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("recovers paid state after the create response is lost but the webhook linked it", async () => {
		await setupPurchaseAttempt();
		const pro = {
			id: "sub_active",
			customer: "cus_1",
			status: "active",
			default_payment_method: "pm_1",
		};
		mockStripe.subscriptions.retrieve
			.mockReset()
			.mockResolvedValueOnce(pro)
			.mockResolvedValueOnce(pro)
			.mockResolvedValueOnce(pro)
			.mockResolvedValueOnce({
				...recoveredSubscription,
				latest_invoice: { status: "paid" },
			})
			.mockResolvedValueOnce(pro);
		mockDb.limit.mockResolvedValueOnce([
			{ subscriptionId: recoveredSubscription.id },
		]);
		mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
		mockStripe.subscriptions.create.mockRejectedValue(
			new Error("response lost"),
		);
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);
		await expect(
			purchaseSignedBaa("org-1" as never, VALID_INPUT),
		).rejects.toThrow("couldn't confirm");
		expect(mockDb.set).toHaveBeenCalledWith({ status: "paid" });
		expect(mockDb.set).not.toHaveBeenCalledWith({ status: "pending" });
	});

	it("cancels an unlinked direct subscription when another payment wins association", async () => {
		await setupPurchaseAttempt();
		mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
		mockStripe.subscriptions.create.mockResolvedValue(recoveredSubscription);
		mockDb.where
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce({ affectedRows: 0 });
		mockDb.limit.mockResolvedValueOnce([
			{ status: "paid", stripeSubscriptionId: "sub_payment_link" },
		]);
		const { purchaseSignedBaa } = await import(
			"@/actions/organization/signed-baa"
		);
		await expect(
			purchaseSignedBaa("org-1" as never, VALID_INPUT),
		).rejects.toThrow("changed while confirming");
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
			recoveredSubscription.id,
		);
		expect(mockDb.set).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "active" }),
		);
		expect(sendEmail).not.toHaveBeenCalled();
	});
});

const paidRecord = {
	id: "baa-record-1",
	organizationId: "org-1",
	userId: "owner-1",
	status: "paid",
	stripeSubscriptionId: "sub_baa_paid" as string | null,
	signedAt: null,
	emailSentAt: null,
	updatedAt: new Date(),
	...VALID_INPUT,
	signatureData: VALID_INPUT.signatureDataUrl,
};

const paidSubscription = {
	id: "sub_baa_paid",
	customer: "cus_payment_link",
	status: "active",
	metadata: {},
	items: { data: [{ price: { id: STRIPE_SIGNED_BAA_PRICE_IDS.development } }] },
	latest_invoice: { status: "paid" },
} as unknown as Stripe.Subscription;

const paidSession = {
	id: "cs_paid_baa",
	mode: "subscription",
	status: "complete",
	payment_status: "paid",
	customer: "cus_payment_link",
	customer_details: { email: "owner@example.com" },
	subscription: "sub_baa_paid",
} as Stripe.Checkout.Session;

const checkoutOwner = {
	id: "owner-1" as never,
	email: "owner@example.com",
	stripeCustomerId: "cus_pro",
	stripeSubscriptionId: "sub_pro",
};

const proSubscription = {
	id: "sub_pro",
	customer: "cus_pro",
	status: "active",
	metadata: {},
};

describe("Paid BAA signing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetMockDb();
		mockStripe.subscriptions.retrieve
			.mockReset()
			.mockResolvedValue(proSubscription);
	});

	async function setupPaidSigning(record = paidRecord) {
		mockOwner({
			stripeCustomerId: "cus_pro",
			stripeSubscriptionId: "sub_pro",
			stripeSubscriptionStatus: "active",
		});
		mockDb.limit.mockResolvedValueOnce([record]);
		mockStripe.subscriptions.retrieve.mockResolvedValueOnce({
			id: "sub_pro",
			customer: "cus_pro",
			status: "active",
		});
		if (record.stripeSubscriptionId) {
			mockStripe.subscriptions.retrieve.mockResolvedValueOnce(paidSubscription);
		}
		vi.mocked(generateSignedBaaPdf).mockResolvedValue(new Uint8Array([1]));
		vi.mocked(sendEmail).mockResolvedValue(undefined as never);
		return import("@/actions/organization/signed-baa");
	}

	it("signs using the paid subscription on a different Stripe customer", async () => {
		const { signPaidBaa } = await setupPaidSigning();
		const result = await signPaidBaa("org-1" as never, VALID_INPUT);
		expect(result).toEqual({ success: true, emailSent: true });
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
		expect(mockStripe.subscriptions.list).not.toHaveBeenCalled();
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "active",
				stripeSubscriptionId: "sub_baa_paid",
				signedAt: expect.any(Date),
			}),
		);
	});

	it("also prevents a duplicate charge through the old purchase action", async () => {
		const { purchaseSignedBaa } = await setupPaidSigning();
		await purchaseSignedBaa("org-1" as never, VALID_INPUT);
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("keeps payment when the new signature cannot generate a PDF", async () => {
		const { signPaidBaa } = await setupPaidSigning();
		vi.mocked(generateSignedBaaPdf).mockRejectedValueOnce(new Error("bad PNG"));
		await expect(signPaidBaa("org-1" as never, VALID_INPUT)).rejects.toThrow(
			"generate the agreement",
		);
		expect(mockDb.set).toHaveBeenCalledWith({ status: "paid" });
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("does not charge when signing an unpaid row", async () => {
		const { signPaidBaa } = await setupPaidSigning({
			...paidRecord,
			status: "pending",
			stripeSubscriptionId: null,
		});
		await expect(signPaidBaa("org-1" as never, VALID_INPUT)).rejects.toThrow(
			"confirmed BAA payment is required",
		);
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("rejects a canceled paid subscription without attempting a new purchase", async () => {
		const { signPaidBaa } = await setupPaidSigning();
		mockStripe.subscriptions.retrieve.mockReset();
		mockStripe.subscriptions.retrieve
			.mockResolvedValueOnce({ id: "sub_pro", status: "active" })
			.mockResolvedValueOnce({ ...paidSubscription, status: "canceled" });
		await expect(signPaidBaa("org-1" as never, VALID_INPUT)).rejects.toThrow(
			"payment is not confirmed",
		);
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("does not finalize or email if cancellation wins while signing", async () => {
		const { signPaidBaa } = await setupPaidSigning();
		mockDb.where
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce({ affectedRows: 1 })
			.mockReturnValueOnce({ affectedRows: 1 })
			.mockReturnValueOnce({ affectedRows: 0 });
		await expect(signPaidBaa("org-1" as never, VALID_INPUT)).rejects.toThrow(
			"changed while signing",
		);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("returns paid details without returning the saved signature", async () => {
		mockOwner({
			stripeCustomerId: "cus_pro",
			stripeSubscriptionStatus: "active",
		});
		mockDb.limit.mockResolvedValueOnce([paidRecord]);
		const { getSignedBaaStatus } = await import(
			"@/actions/organization/signed-baa"
		);
		const status = await getSignedBaaStatus("org-1" as never);
		expect(status.status).toBe("paid");
		expect(status.details?.entityName).toBe(VALID_INPUT.entityName);
		expect(status.details).not.toHaveProperty("signatureData");
		expect(status.signedAt).toBeNull();
	});

	it("does not claim a row if a checkout changes its payment state first", async () => {
		const { signPaidBaa } = await setupPaidSigning();
		mockDb.where
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce(mockDb)
			.mockReturnValueOnce({ affectedRows: 0 });
		await expect(signPaidBaa("org-1" as never, VALID_INPUT)).rejects.toThrow(
			"already in progress",
		);
		expect(mockDb.where).toHaveBeenCalledWith([
			{ field: "signedBaaId", value: "baa-record-1" },
			{ field: "signedBaaStatus", value: "paid" },
			{ field: "signedBaaStripeSubscriptionId", value: "sub_baa_paid" },
			expect.any(Array),
		]);
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
		expect(generateSignedBaaPdf).not.toHaveBeenCalled();
	});

	it("requires authentication before retrieving a checkout session", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		const { confirmSignedBaaPayment } = await import(
			"@/actions/organization/signed-baa"
		);
		await expect(
			confirmSignedBaaPayment("org-1" as never, "cs_paid_baa"),
		).rejects.toThrow("Unauthorized");
		expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
	});

	it("requires the actual organization owner before confirming payment", async () => {
		mockGetCurrentUser.mockResolvedValue({ id: "other-owner" });
		mockDb.limit.mockResolvedValueOnce([{ id: "org-1", ownerId: "owner-1" }]);
		const { confirmSignedBaaPayment } = await import(
			"@/actions/organization/signed-baa"
		);
		await expect(
			confirmSignedBaaPayment("org-1" as never, "cs_paid_baa"),
		).rejects.toThrow("Only the organization owner");
		expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
	});

	it("confirms a Stripe session and returns the refreshed paid status", async () => {
		mockOwner({
			stripeCustomerId: "cus_pro",
			stripeSubscriptionId: "sub_pro",
			stripeSubscriptionStatus: "active",
		});
		mockStripe.checkout.sessions.retrieve.mockResolvedValueOnce(paidSession);
		mockStripe.subscriptions.retrieve
			.mockReset()
			.mockResolvedValueOnce(paidSubscription)
			.mockResolvedValueOnce(proSubscription);
		mockDb.limit
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ ...paidRecord, status: "pending", stripeSubscriptionId: null },
			])
			.mockResolvedValueOnce([{ ownerId: "owner-1" }])
			.mockResolvedValueOnce([{ ...paidRecord, status: "pending" }])
			.mockResolvedValueOnce([paidRecord])
			.mockResolvedValueOnce([{ id: "org-1", ownerId: "owner-1" }])
			.mockResolvedValueOnce([paidRecord]);
		const { confirmSignedBaaPayment } = await import(
			"@/actions/organization/signed-baa"
		);
		expect(
			(await confirmSignedBaaPayment("org-1" as never, "cs_paid_baa")).status,
		).toBe("paid");
		expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
			"cs_paid_baa",
		);
		expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
	});
});

describe("Paid BAA checkout association", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetMockDb();
		mockStripe.subscriptions.retrieve
			.mockReset()
			.mockResolvedValue(proSubscription);
	});

	const expected = { owner: checkoutOwner, organizationId: "org-1" as never };
	const pendingRecord = {
		...paidRecord,
		status: "pending",
		stripeSubscriptionId: null,
	};

	it("attaches a paid link with no metadata and a different Stripe customer", async () => {
		mockDb.limit
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([pendingRecord])
			.mockResolvedValueOnce([{ ownerId: "owner-1" }])
			.mockResolvedValueOnce([{ ...paidRecord, status: "pending" }])
			.mockResolvedValueOnce([paidRecord]);
		const record = await attachPaidBaaCheckout(
			paidSession,
			paidSubscription,
			expected,
		);
		expect(record?.status).toBe("paid");
		expect(mockDb.update).toHaveBeenCalledWith(signedBaas);
		expect(mockDb.set).toHaveBeenCalledWith({
			stripeSubscriptionId: "sub_baa_paid",
		});
		expect(mockDb.set).toHaveBeenCalledWith({ status: "paid" });
	});

	it.each(["unpaid", "no_payment_required"])(
		"does not accept %s checkout",
		async (paymentStatus) => {
			const result = await attachPaidBaaCheckout(
				{
					...paidSession,
					payment_status: paymentStatus,
				} as Stripe.Checkout.Session,
				paidSubscription,
				expected,
			);
			expect(result).toBeNull();
			expect(mockDb.update).not.toHaveBeenCalled();
		},
	);

	it("does not accept a paid non-BAA subscription", async () => {
		const result = await attachPaidBaaCheckout(
			paidSession,
			{
				...paidSubscription,
				items: { data: [{ price: { id: "price_pro" } }] },
			} as Stripe.Subscription,
			expected,
		);
		expect(result).toBeNull();
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("rejects payment belonging to a different email", async () => {
		await expect(
			attachPaidBaaCheckout(
				{
					...paidSession,
					customer_details: { email: "other@example.com" },
				} as Stripe.Checkout.Session,
				paidSubscription,
				expected,
			),
		).rejects.toThrow("different account");
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("rejects a subscription already attached to another organization", async () => {
		mockDb.limit.mockResolvedValueOnce([
			{ ...paidRecord, organizationId: "org-2" },
		]);
		await expect(
			attachPaidBaaCheckout(paidSession, paidSubscription, expected),
		).rejects.toThrow("different organization");
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("does not guess between multiple pending organizations", async () => {
		mockDb.limit
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				pendingRecord,
				{ ...pendingRecord, id: "other", organizationId: "org-2" },
			]);
		expect(
			await attachPaidBaaCheckout(paidSession, paidSubscription, expected),
		).toBeNull();
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("does not overwrite the signature or paid state on duplicate checkout delivery", async () => {
		mockDb.limit
			.mockResolvedValueOnce([paidRecord])
			.mockResolvedValueOnce([{ ownerId: "owner-1" }]);
		expect(
			await attachPaidBaaCheckout(paidSession, paidSubscription, expected),
		).toEqual(paidRecord);
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("cancels a second paid checkout instead of replacing the existing subscription", async () => {
		const previous = { ...paidRecord, stripeSubscriptionId: "sub_existing" };
		mockDb.limit
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([previous])
			.mockResolvedValueOnce([{ ownerId: "owner-1" }]);
		mockStripe.subscriptions.retrieve.mockResolvedValueOnce({
			...paidSubscription,
			id: "sub_existing",
		});
		expect(
			await attachPaidBaaCheckout(paidSession, paidSubscription, expected),
		).toEqual(previous);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
			paidSubscription.id,
		);
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("cancels the losing checkout when two paid subscriptions race for the pending row", async () => {
		const winner = { ...paidRecord, stripeSubscriptionId: "sub_winner" };
		mockDb.limit
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([pendingRecord])
			.mockResolvedValueOnce([{ ownerId: "owner-1" }])
			.mockResolvedValueOnce([winner]);
		mockStripe.subscriptions.retrieve.mockResolvedValueOnce({
			...paidSubscription,
			id: "sub_winner",
		});
		expect(
			await attachPaidBaaCheckout(paidSession, paidSubscription, expected),
		).toEqual(winner);
		expect(mockStripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
			paidSubscription.id,
		);
		expect(mockDb.set).not.toHaveBeenCalledWith({ status: "paid" });
	});

	it("fails closed when another subscription wins the association race", async () => {
		mockDb.limit
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([pendingRecord])
			.mockResolvedValueOnce([{ ownerId: "owner-1" }])
			.mockResolvedValueOnce([
				{ ...paidRecord, stripeSubscriptionId: "sub_other" },
			]);
		await expect(
			attachPaidBaaCheckout(paidSession, paidSubscription, expected),
		).rejects.toThrow("changed while confirming");
		expect(mockDb.where).toHaveBeenCalledWith([
			{ field: "signedBaaId", value: "baa-record-1" },
			{ field: "signedBaaStatus", value: "pending" },
			{ isNull: "signedBaaStripeSubscriptionId" },
		]);
	});
});
