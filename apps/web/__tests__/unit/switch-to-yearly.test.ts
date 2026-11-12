import { getCurrentUser } from "@cap/database/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
	select: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
};

const mockStripe = {
	subscriptions: { retrieve: vi.fn(), update: vi.fn() },
	prices: { retrieve: vi.fn() },
	invoices: { retrieveUpcoming: vi.fn() },
};

vi.mock("@cap/database", () => ({ db: () => mockDb }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/schema", () => ({
	users: {
		id: "userId",
		stripeCustomerId: "stripeCustomerId",
		stripeSubscriptionId: "stripeSubscriptionId",
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
	serverEnv: () => ({ VERCEL_ENV: "production" }),
}));
vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return { ...actual, stripe: () => mockStripe };
});
vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

const YEARLY = "price_1S2al7FJxA1XpeSsJCI5Z2UD";
const MONTHLY = "price_1S2akxFJxA1XpeSsfoAUUbpJ";
const PRODUCT = "prod_pro";

function subscription(overrides: Record<string, unknown> = {}) {
	return {
		id: "sub_1",
		customer: "cus_1",
		status: "active",
		cancel_at_period_end: false,
		metadata: {},
		items: {
			data: [
				{
					id: "si_1",
					quantity: 3,
					price: {
						id: MONTHLY,
						product: PRODUCT,
						recurring: { interval: "month" },
					},
				},
			],
		},
		...overrides,
	};
}

function setup(sub = subscription()) {
	mockGetCurrentUser.mockResolvedValue({ id: "user_1" });
	mockDb.select.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.where.mockReturnValue(mockDb);
	mockDb.limit.mockResolvedValue([
		{ stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" },
	]);
	mockStripe.subscriptions.retrieve.mockResolvedValue(sub);
	mockStripe.prices.retrieve.mockResolvedValue({
		id: YEARLY,
		product: PRODUCT,
	});
}

describe("switch to yearly", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("previews a year at the yearly price less the unused month", async () => {
		setup();
		mockStripe.invoices.retrieveUpcoming.mockResolvedValue({
			amount_due: 28200,
			currency: "usd",
			period_end: 1794429164,
			lines: {
				data: [
					{ proration: true, amount: -1200, period: { end: 1794429164 } },
					{ proration: false, amount: 29400, period: { end: 1825965166 } },
				],
			},
		});
		const { previewYearlySwitch } = await import(
			"@/actions/billing/switch-to-yearly"
		);

		const preview = await previewYearlySwitch();

		expect(preview).toEqual({
			ok: true,
			quantity: 3,
			dueToday: 28200,
			yearlyAmount: 29400,
			renewsOn: 1825965166,
			currency: "usd",
		});
		expect(mockStripe.prices.retrieve).toHaveBeenCalledWith(YEARLY);
		expect(mockStripe.invoices.retrieveUpcoming).toHaveBeenCalledWith({
			customer: "cus_1",
			subscription: "sub_1",
			subscription_items: [{ id: "si_1", price: YEARLY, quantity: 3 }],
			subscription_proration_behavior: "always_invoice",
		});
	});

	it("swaps the price, keeps seats and only applies once paid", async () => {
		setup();
		mockStripe.subscriptions.update.mockResolvedValue({ pending_update: null });
		const { switchToYearly } = await import(
			"@/actions/billing/switch-to-yearly"
		);

		await expect(switchToYearly(3)).resolves.toEqual({ ok: true });
		expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			items: [{ id: "si_1", price: YEARLY, quantity: 3 }],
			proration_behavior: "always_invoice",
			payment_behavior: "pending_if_incomplete",
		});
		expect(revalidatePathMock).toHaveBeenCalled();
	});

	it("reports a declined charge and leaves the plan monthly", async () => {
		setup();
		mockStripe.subscriptions.update.mockResolvedValue({
			pending_update: { expires_at: 1 },
		});
		const { switchToYearly } = await import(
			"@/actions/billing/switch-to-yearly"
		);

		const result = await switchToYearly(3);

		expect(result.ok).toBe(false);
		expect(revalidatePathMock).not.toHaveBeenCalled();
	});

	it.each([
		["past due", { status: "past_due" }],
		["canceling", { cancel_at_period_end: true }],
		["another customer", { customer: "cus_other" }],
		[
			"already yearly",
			{
				items: {
					data: [
						{
							id: "si_1",
							quantity: 1,
							price: {
								id: YEARLY,
								product: PRODUCT,
								recurring: { interval: "year" },
							},
						},
					],
				},
			},
		],
		[
			"a different product",
			{
				items: {
					data: [
						{
							id: "si_1",
							quantity: 1,
							price: {
								id: "price_other",
								product: "prod_other",
								recurring: { interval: "month" },
							},
						},
					],
				},
			},
		],
	])("refuses a subscription that is %s", async (_label, overrides) => {
		setup(subscription(overrides));
		const { switchToYearly, previewYearlySwitch } = await import(
			"@/actions/billing/switch-to-yearly"
		);

		expect((await previewYearlySwitch()).ok).toBe(false);
		expect((await switchToYearly(1)).ok).toBe(false);
		expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
		expect(mockStripe.invoices.retrieveUpcoming).not.toHaveBeenCalled();
	});

	it("refuses when the seat count changed since the quote", async () => {
		setup();
		const { switchToYearly } = await import(
			"@/actions/billing/switch-to-yearly"
		);

		const result = await switchToYearly(2);

		expect(result.ok).toBe(false);
		expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
	});

	it("refuses when signed out", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		const { switchToYearly } = await import(
			"@/actions/billing/switch-to-yearly"
		);

		expect((await switchToYearly(1)).ok).toBe(false);
		expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
	});
});
