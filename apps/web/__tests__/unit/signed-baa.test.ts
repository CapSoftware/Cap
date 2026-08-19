import { getCurrentUser } from "@cap/database/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
	subscriptions: {
		retrieve: vi.fn(),
		list: vi.fn(),
		create: vi.fn(),
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
	},
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
	mockDb.where.mockReturnValue(mockDb);
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
});
