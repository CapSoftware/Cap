import { getCurrentUser } from "@cap/database/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
	select: vi.fn(),
	update: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
	set: vi.fn(),
};

const mockStripe = {
	subscriptions: {
		retrieve: vi.fn(),
		update: vi.fn(),
	},
};

vi.mock("@cap/database", () => ({
	db: () => mockDb,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	organizationMembers: {
		id: "memberId",
		userId: "memberUserId",
		organizationId: "memberOrganizationId",
		hasProSeat: "memberHasProSeat",
	},
	organizations: {
		id: "organizationId",
		ownerId: "organizationOwnerId",
	},
	users: {
		id: "userId",
		inviteQuota: "inviteQuota",
		stripeCustomerId: "stripeCustomerId",
		stripeSubscriptionId: "stripeSubscriptionId",
	},
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));

vi.mock("@cap/utils", () => ({
	stripe: () => mockStripe,
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
	revalidatePath: revalidatePathMock,
}));

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

function resetMockDb() {
	for (const key of Object.keys(mockDb)) {
		const fn = mockDb[key as keyof typeof mockDb];
		fn.mockClear();
	}
	mockDb.select.mockReturnValue(mockDb);
	mockDb.update.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.where.mockReturnValue(mockDb);
	mockDb.limit.mockResolvedValue([]);
	mockDb.set.mockReturnValue(mockDb);
}

function mockSeatLookup({
	currentQuantity,
	proSeatsUsed = 1,
}: {
	currentQuantity: number;
	proSeatsUsed?: number;
}) {
	mockGetCurrentUser.mockResolvedValue({
		id: "owner-1",
		email: "owner@example.com",
	});
	mockDb.limit
		.mockResolvedValueOnce([{ id: "org-1", ownerId: "owner-1" }])
		.mockResolvedValueOnce([
			{
				stripeCustomerId: "cus_1",
				stripeSubscriptionId: "sub_1",
				inviteQuota: currentQuantity,
			},
		]);
	mockDb.where
		.mockReturnValueOnce(mockDb)
		.mockReturnValueOnce(mockDb)
		.mockResolvedValueOnce(
			Array.from({ length: proSeatsUsed }, (_, index) => ({
				id: `member-${index}`,
				userId: index === 0 ? "owner-1" : `user-${index}`,
				hasProSeat: true,
			})),
		)
		.mockResolvedValueOnce([]);
	mockStripe.subscriptions.retrieve.mockResolvedValue({
		id: "sub_1",
		cancel_at_period_end: false,
		items: {
			data: [{ id: "si_1", quantity: currentQuantity }],
		},
	});
}

describe("updateSeatQuantity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetMockDb();
		mockStripe.subscriptions.update.mockResolvedValue({
			id: "sub_1",
			pending_update: null,
		});
	});

	it("immediately invoices seat increases and only stores the quota after Stripe applies the update", async () => {
		mockSeatLookup({ currentQuantity: 1 });
		const { updateSeatQuantity } = await import(
			"@/actions/organization/update-seat-quantity"
		);

		const result = await updateSeatQuantity("org-1" as never, 2);

		expect(result).toEqual({
			success: true,
			newQuantity: 2,
			cancelAtPeriodEnd: false,
		});
		expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			items: [{ id: "si_1", quantity: 2 }],
			payment_behavior: "pending_if_incomplete",
			proration_behavior: "always_invoice",
		});
		expect(mockDb.set).toHaveBeenCalledWith({ inviteQuota: 2 });
	});

	it("does not store added seats when Stripe leaves the subscription update pending", async () => {
		mockSeatLookup({ currentQuantity: 1 });
		mockStripe.subscriptions.update.mockResolvedValueOnce({
			id: "sub_1",
			pending_update: { expires_at: 123 },
		});
		const { updateSeatQuantity } = await import(
			"@/actions/organization/update-seat-quantity"
		);

		await expect(updateSeatQuantity("org-1" as never, 2)).rejects.toThrow(
			"Payment for the added seats could not be completed.",
		);
		expect(mockDb.set).not.toHaveBeenCalled();
	});

	it("does not credit the current period when seats decrease", async () => {
		mockSeatLookup({ currentQuantity: 3 });
		const { updateSeatQuantity } = await import(
			"@/actions/organization/update-seat-quantity"
		);

		await updateSeatQuantity("org-1" as never, 2);

		expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			items: [{ id: "si_1", quantity: 2 }],
			proration_behavior: "none",
		});
	});

	it("clears scheduled cancellation in the same decrease update", async () => {
		mockSeatLookup({ currentQuantity: 3 });
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_1",
			cancel_at_period_end: true,
			items: {
				data: [{ id: "si_1", quantity: 3 }],
			},
		});
		const { updateSeatQuantity } = await import(
			"@/actions/organization/update-seat-quantity"
		);

		await updateSeatQuantity("org-1" as never, 2);

		expect(mockStripe.subscriptions.update).toHaveBeenCalledTimes(1);
		expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			items: [{ id: "si_1", quantity: 2 }],
			proration_behavior: "none",
			cancel_at_period_end: false,
		});
	});

	it("restores scheduled cancellation when a seat increase fails", async () => {
		mockSeatLookup({ currentQuantity: 1 });
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_1",
			cancel_at_period_end: true,
			items: {
				data: [{ id: "si_1", quantity: 1 }],
			},
		});
		mockStripe.subscriptions.update
			.mockResolvedValueOnce({ id: "sub_1", pending_update: null })
			.mockRejectedValueOnce(new Error("card declined"));
		const { updateSeatQuantity } = await import(
			"@/actions/organization/update-seat-quantity"
		);

		await expect(updateSeatQuantity("org-1" as never, 2)).rejects.toThrow(
			"card declined",
		);
		expect(mockStripe.subscriptions.update).toHaveBeenNthCalledWith(
			1,
			"sub_1",
			{
				cancel_at_period_end: false,
			},
		);
		expect(mockStripe.subscriptions.update).toHaveBeenNthCalledWith(
			3,
			"sub_1",
			{
				cancel_at_period_end: true,
			},
		);
		expect(mockDb.set).not.toHaveBeenCalled();
	});

	it("restores scheduled cancellation when added seats stay pending", async () => {
		mockSeatLookup({ currentQuantity: 1 });
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_1",
			cancel_at_period_end: true,
			items: {
				data: [{ id: "si_1", quantity: 1 }],
			},
		});
		mockStripe.subscriptions.update
			.mockResolvedValueOnce({ id: "sub_1", pending_update: null })
			.mockResolvedValueOnce({
				id: "sub_1",
				pending_update: { expires_at: 123 },
			});
		const { updateSeatQuantity } = await import(
			"@/actions/organization/update-seat-quantity"
		);

		await expect(updateSeatQuantity("org-1" as never, 2)).rejects.toThrow(
			"Payment for the added seats could not be completed.",
		);
		expect(mockStripe.subscriptions.update).toHaveBeenNthCalledWith(
			3,
			"sub_1",
			{
				cancel_at_period_end: true,
			},
		);
	});

	it("does not restore cancellation after Stripe applies the new quantity", async () => {
		mockSeatLookup({ currentQuantity: 1 });
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_1",
			cancel_at_period_end: true,
			items: {
				data: [{ id: "si_1", quantity: 1 }],
			},
		});
		mockDb.set.mockImplementation(() => {
			throw new Error("db down");
		});
		const { updateSeatQuantity } = await import(
			"@/actions/organization/update-seat-quantity"
		);

		await expect(updateSeatQuantity("org-1" as never, 2)).rejects.toThrow(
			"local state could not be saved",
		);
		expect(mockStripe.subscriptions.update).not.toHaveBeenCalledWith("sub_1", {
			cancel_at_period_end: true,
		});
	});
});
