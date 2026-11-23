import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStripe = {
	subscriptions: { retrieve: vi.fn(), update: vi.fn(), list: vi.fn() },
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
	charges: { retrieve: vi.fn() },
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
	reverseCapFridayCredit,
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
		default_payment_method: {
			id: "pm_sub",
			card: { brand: "visa", last4: "4242" },
		},
		latest_invoice: null,
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
	mockStripe.subscriptions.list.mockResolvedValue({
		data: [{ id: "sub_1", status: "active" }],
	});
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

	it("refuses accounts with another live subscription sharing the credit", async () => {
		mockStripe.subscriptions.list.mockResolvedValue({
			data: [
				{ id: "sub_1", status: "active" },
				{ id: "sub_baa", status: "active" },
			],
		});
		expect(await getCapFridayState(owner)).toEqual({
			type: "unavailable",
			reason: "custom",
		});
	});

	it("finds a monthly switch from the subscription when metadata is missing", async () => {
		const SWITCHED_END = 1_860_000_000;
		mockStripe.subscriptions.retrieve.mockResolvedValue(
			subscription({
				current_period_end: SWITCHED_END,
				latest_invoice: {
					status: "paid",
					metadata: {},
					discount: { coupon: { id: "CAP_FRIDAY_2026_EXISTING" } },
					discounts: [],
				},
			}),
		);
		expect(await getCapFridayState(owner)).toEqual({
			type: "redeemed",
			kind: "switch",
			renewsOn: SWITCHED_END,
		});
	});

	it("charges the card it shows", async () => {
		mockStripe.customers.retrieve.mockResolvedValue({
			id: "cus_1",
			balance: 0,
			metadata: {},
			invoice_settings: { default_payment_method: "pm_customer" },
		});
		mockStripe.invoices.create.mockResolvedValue({ id: "in_1" });
		mockStripe.invoiceItems.create.mockResolvedValue({ id: "ii_1" });
		mockStripe.invoices.finalizeInvoice.mockResolvedValue({
			id: "in_1",
			status: "open",
			total: 7200,
		});
		mockStripe.invoices.pay.mockResolvedValue({
			id: "in_1",
			status: "paid",
			metadata: {},
		});
		const result = await redeemCapFriday(owner, { dueToday: 7200 });
		expect(result).toEqual({ ok: true, kind: "prepay", renewsOn: PERIOD_END });
		expect(mockStripe.invoices.create).toHaveBeenCalledWith(
			expect.objectContaining({ default_payment_method: "pm_sub" }),
			expect.anything(),
		);
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
			metadata: { capFriday2026: "prepay", renewsOn: String(PERIOD_END) },
		});
		expect(await getCapFridayState(owner)).toEqual({
			type: "redeemed",
			kind: "prepay",
			renewsOn: PERIOD_END,
		});
		const result = await redeemCapFriday(owner, { dueToday: 7200 });
		expect(result).toEqual({ ok: true, kind: "prepay", renewsOn: PERIOD_END });
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

	describe("refunds and disputes", () => {
		const prepay = (metadata: Record<string, string> = {}) => ({
			id: "in_1",
			customer: "cus_1",
			currency: "usd",
			number: "CAP-1",
			metadata: {
				capFriday2026: "prepay",
				creditAmount: "14400",
				capFridayCreditTxn: "cbtxn_1",
				...metadata,
			},
		});
		const charge = (refunded: number) => ({
			object: "charge",
			invoice: "in_1",
			amount: 7200,
			amount_refunded: refunded,
		});

		it("takes back credit in proportion to a partial refund", async () => {
			mockStripe.invoices.retrieve.mockResolvedValue(prepay());
			expect(await reverseCapFridayCredit(charge(3600) as never)).toBe(
				"reversed",
			);
			expect(
				mockStripe.customers.createBalanceTransaction,
			).toHaveBeenCalledWith(
				"cus_1",
				expect.objectContaining({ amount: 7200, currency: "usd" }),
				{ idempotencyKey: "capfriday-reverse-in_1-7200" },
			);
			expect(mockStripe.invoices.update).toHaveBeenCalledWith("in_1", {
				metadata: { capFridayReversed: "7200" },
			});
		});

		it("only reverses the remainder on a later full refund", async () => {
			mockStripe.invoices.retrieve.mockResolvedValue(
				prepay({ capFridayReversed: "7200" }),
			);
			await reverseCapFridayCredit(charge(7200) as never);
			expect(
				mockStripe.customers.createBalanceTransaction,
			).toHaveBeenCalledWith(
				"cus_1",
				expect.objectContaining({ amount: 7200 }),
				{ idempotencyKey: "capfriday-reverse-in_1-14400" },
			);
		});

		it("does nothing twice for the same refund", async () => {
			mockStripe.invoices.retrieve.mockResolvedValue(
				prepay({ capFridayReversed: "14400" }),
			);
			expect(await reverseCapFridayCredit(charge(7200) as never)).toBe(
				"reversed",
			);
			expect(
				mockStripe.customers.createBalanceTransaction,
			).not.toHaveBeenCalled();
		});

		it("reverses the whole credit on a dispute", async () => {
			mockStripe.charges.retrieve.mockResolvedValue(charge(0));
			mockStripe.invoices.retrieve.mockResolvedValue(prepay());
			await reverseCapFridayCredit({
				object: "dispute",
				charge: "ch_1",
			} as never);
			expect(
				mockStripe.customers.createBalanceTransaction,
			).toHaveBeenCalledWith(
				"cus_1",
				expect.objectContaining({ amount: 14400 }),
				expect.anything(),
			);
		});

		it("waits for the grant before reversing", async () => {
			mockStripe.invoices.retrieve.mockResolvedValue(
				prepay({ capFridayCreditTxn: "" }),
			);
			expect(await reverseCapFridayCredit(charge(7200) as never)).toBe(
				"awaiting_grant",
			);
		});

		it("ignores other charges", async () => {
			mockStripe.invoices.retrieve.mockResolvedValue({
				id: "in_2",
				metadata: {},
			});
			expect(await reverseCapFridayCredit(charge(100) as never)).toBe("none");
			expect(
				await reverseCapFridayCredit({
					object: "charge",
					invoice: null,
				} as never),
			).toBe("none");
		});
	});
});
