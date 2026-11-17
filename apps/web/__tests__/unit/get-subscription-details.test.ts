import { getCurrentUser } from "@cap/database/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
	select: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
};

const mockStripe = {
	subscriptions: { retrieve: vi.fn() },
};

vi.mock("@cap/database", () => ({ db: () => mockDb }));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	organizations: { id: "organizationId" },
	users: {
		id: "userId",
		stripeCustomerId: "stripeCustomerId",
		stripeSubscriptionId: "stripeSubscriptionId",
	},
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));

vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return { ...actual, stripe: () => mockStripe };
});

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

describe("getSubscriptionDetails", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.select.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.where.mockReturnValue(mockDb);
		mockDb.limit
			.mockResolvedValueOnce([{ id: "org-1", ownerId: "owner-1" }])
			.mockResolvedValueOnce([
				{ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" },
			]);
		(getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "owner-1",
		});
	});

	it("reports the currency the subscription is billed in, not the price's default", async () => {
		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_1",
			customer: "cus_1",
			status: "active",
			currency: "gbp",
			cancel_at_period_end: false,
			current_period_end: 1_800_000_000,
			metadata: {},
			items: {
				data: [
					{
						quantity: 2,
						price: {
							id: "price_pro_monthly",
							currency: "usd",
							billing_scheme: "per_unit",
							unit_amount: 1200,
							recurring: { interval: "month" },
						},
					},
				],
			},
		});

		const { getSubscriptionDetails } = await import(
			"@/actions/organization/get-subscription-details"
		);
		const details = await getSubscriptionDetails("org-1" as never);

		expect(details).toMatchObject({
			currency: "gbp",
			pricePerSeat: 12,
			currentQuantity: 2,
		});
	});
});
