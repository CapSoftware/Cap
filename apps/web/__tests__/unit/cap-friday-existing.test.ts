import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStripe = {
	subscriptions: { retrieve: vi.fn(), update: vi.fn() },
	customers: {
		retrieve: vi.fn(),
		update: vi.fn(),
		createBalanceTransaction: vi.fn(),
	},
	invoices: {
		retrieve: vi.fn(),
		retrieveUpcoming: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		finalizeInvoice: vi.fn(),
		voidInvoice: vi.fn(),
		pay: vi.fn(),
	},
	invoiceItems: { create: vi.fn() },
	coupons: { retrieve: vi.fn(), create: vi.fn() },
	paymentMethods: { retrieve: vi.fn() },
};

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ VERCEL_ENV: "development" }),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
}));

vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return { ...actual, stripe: () => mockStripe };
});

import { ENDS_AT } from "@/components/pages/blackfriday/content";
import {
	getCapFridayState,
	grantCapFridayCredit,
	redeemCapFriday,
} from "@/lib/checkout/cap-friday";

const YEARLY = "price_1Q3esrFJxA1XpeSsFwp486RN";
const MONTHLY = "price_1P9C1DFJxA1XpeSsTwwuddnq";
const owner = { stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" };
const PERIOD_END = 1_830_000_000;

function subscription(overrides: Record<string, unknown> = {}) {
	return {
		id: "sub_1",
		customer: "cus_1",
		status: "active",
		cancel_at_period_end: false,
		cancel_at: null,
		discount: null,
		schedule: null,
		automatic_tax: { enabled: false },
		default_tax_rates: [],
		collection_method: "charge_automatically",
		current_period_end: PERIOD_END,
		metadata: {},
		default_payment_method: { card: { brand: "visa", last4: "4242" } },
		items: {
			data: [
				{
					id: "si_1",
					quantity: 2,
					price: { id: YEARLY, recurring: { interval: "year" } },
				},
			],
		},
		...overrides,
	};
}

const renewalPreview = {
	currency: "usd",
	tax: 0,
	total_discount_amounts: [],
	lines: {
		has_more: false,
		data: [{ type: "subscription", proration: false, amount: 14400 }],
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
	mockStripe.subscriptions.retrieve.mockResolvedValue(subscription());
	mockStripe.customers.retrieve.mockResolvedValue({
		id: "cus_1",
		balance: 0,
		metadata: {},
		invoice_settings: {},
	});
	mockStripe.invoices.retrieveUpcoming.mockResolvedValue(renewalPreview);
	mockStripe.coupons.retrieve.mockResolvedValue({ id: "coupon" });
});

describe("Cap Friday for existing subscribers", () => {
	it("quotes half of the yearly renewal, paid by credit at renewal", async () => {
		const state = await getCapFridayState(owner);
		expect(state).toMatchObject({
			type: "quote",
			quote: {
				kind: "yearly",
				seats: 2,
				dueToday: 7200,
				renewalAmount: 14400,
				renewsOn: PERIOD_END,
				card: { brand: "visa", last4: "4242" },
			},
		});
	});

	it("is closed once the offer ends", async () => {
		vi.useFakeTimers({ now: ENDS_AT + 1, toFake: ["Date"] });
		expect(await getCapFridayState(owner)).toEqual({
			type: "unavailable",
			reason: "ended",
		});
		expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
	});

	it.each([
		["canceling", { cancel_at_period_end: true }],
		["past_due", { status: "past_due" }],
		["custom", { discount: { coupon: { id: "deal" } } }],
		["custom", { schedule: "sub_sched_1" }],
		["custom", { collection_method: "send_invoice" }],
		["custom", { automatic_tax: { enabled: true } }],
		["no_card", { default_payment_method: null }],
	])("refuses %s plans", async (reason, overrides) => {
		mockStripe.subscriptions.retrieve.mockResolvedValue(
			subscription(overrides),
		);
		expect(await getCapFridayState(owner)).toEqual({
			type: "unavailable",
			reason,
		});
	});

	it("refuses an account that already holds credit", async () => {
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			balance: -500,
			metadata: {},
			invoice_settings: {},
		});
		expect(await getCapFridayState(owner)).toEqual({
			type: "unavailable",
			reason: "custom",
		});
	});

	it("refuses a subscription owned by another customer", async () => {
		mockStripe.subscriptions.retrieve.mockResolvedValue(
			subscription({ customer: "cus_other" }),
		);
		expect(await getCapFridayState(owner)).toEqual({
			type: "unavailable",
			reason: "not_owner",
		});
	});

	it("shows a paid redemption instead of a second offer", async () => {
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			metadata: { capFriday2026Invoice: "in_1" },
		});
		mockStripe.invoices.retrieve.mockResolvedValue({
			status: "paid",
			metadata: { renewsOn: String(PERIOD_END) },
		});
		expect(await getCapFridayState(owner)).toEqual({
			type: "redeemed",
			renewsOn: PERIOD_END,
		});
		const result = await redeemCapFriday(owner, { dueToday: 7200 });
		expect(result).toEqual({ ok: true, renewsOn: PERIOD_END });
		expect(mockStripe.invoices.create).not.toHaveBeenCalled();
	});

	it("charges nothing when the price moved since the page loaded", async () => {
		const result = await redeemCapFriday(owner, { dueToday: 5000 });
		expect(result).toMatchObject({ ok: false });
		expect(mockStripe.invoices.create).not.toHaveBeenCalled();
	});

	it("rejects a stale monthly quote", async () => {
		mockStripe.subscriptions.retrieve.mockResolvedValue(
			subscription({
				items: {
					data: [
						{
							id: "si_1",
							quantity: 1,
							price: { id: MONTHLY, recurring: { interval: "month" } },
						},
					],
				},
			}),
		);
		const result = await redeemCapFriday(owner, {
			dueToday: 4000,
			prorationDate: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
		});
		expect(result).toMatchObject({ ok: false });
		expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
	});

	it("grants the renewal credit once", async () => {
		const invoice = {
			id: "in_1",
			status: "paid",
			customer: "cus_1",
			currency: "usd",
			metadata: { capFriday2026: "prepay", creditAmount: "14400" },
		};
		mockStripe.invoices.retrieve.mockResolvedValueOnce(invoice);
		mockStripe.customers.createBalanceTransaction.mockResolvedValue({
			id: "cbtxn_1",
		});
		await grantCapFridayCredit(invoice as never);
		expect(mockStripe.customers.createBalanceTransaction).toHaveBeenCalledWith(
			"cus_1",
			expect.objectContaining({ amount: -14400, currency: "usd" }),
			{ idempotencyKey: "capfriday-credit-in_1" },
		);

		mockStripe.invoices.retrieve.mockResolvedValueOnce({
			...invoice,
			metadata: { ...invoice.metadata, capFridayCreditTxn: "cbtxn_1" },
		});
		await grantCapFridayCredit(invoice as never);
		expect(mockStripe.customers.createBalanceTransaction).toHaveBeenCalledTimes(
			1,
		);
	});

	it("ignores invoices that are not Cap Friday prepayments", async () => {
		await grantCapFridayCredit({
			id: "in_2",
			status: "paid",
			metadata: {},
		} as never);
		expect(mockStripe.invoices.retrieve).not.toHaveBeenCalled();
	});
});
