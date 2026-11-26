import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: null as unknown,
	ids: 0,
	listRefunds: vi.fn(),
	retrievePaymentIntent: vi.fn(),
	listSessions: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: () => mocks.db }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `row-${++mocks.ids}`,
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		refunds: { list: mocks.listRefunds },
		paymentIntents: { retrieve: mocks.retrievePaymentIntent },
		checkout: { sessions: { list: mocks.listSessions } },
	}),
}));
vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_credits",
}));

import type Stripe from "stripe";
import { addCreditsToAccount } from "@/lib/developer-credits";
import { transcriptStartRefusal } from "@/lib/developer-transcript-billing";
import { creditCheckoutSessionParams } from "@/lib/infra-credit-checkout";
import {
	awaitsCreditGrant,
	refundedShareMicroCredits,
	reverseDisputedPayment,
	reverseRefundedCharge,
} from "@/lib/infra-credit-reversal";
import { describeLedgerRow, serializeLedgerRow } from "@/lib/infra-ledger";
import { DISPUTED_UPLOAD_MESSAGE, getInfraBilling } from "@/lib/infra-standing";
import { infraVideoFailure } from "@/lib/infra-video-view";
import {
	advanceDays,
	fakeDb,
	type LedgerRow,
	ledger,
	resetLedger,
} from "./infra-billing-fake-db";

mocks.db = fakeDb;

const GRANT = 2_500_000;

const refund = (id: string, amount: number, status = "succeeded") =>
	({
		id,
		amount,
		status,
		created: Number(id.replace(/\D/g, "")),
	}) as Stripe.Refund;

const charge = (
	paymentIntent: string | null,
	refunds: Stripe.Refund[] | null,
	extra: Partial<Stripe.Charge> = {},
) =>
	({
		id: "ch_1",
		amount: 2500,
		currency: "usd",
		payment_intent: paymentIntent,
		amount_refunded: (refunds ?? []).reduce(
			(total, item) => total + item.amount,
			0,
		),
		...(refunds
			? { refunds: { object: "list", data: refunds, has_more: false } }
			: {}),
		...extra,
	}) as Stripe.Charge;

const dispute = (id: string, paymentIntent: string | null) =>
	({
		id,
		amount: 2500,
		charge: "ch_1",
		payment_intent: paymentIntent,
		reason: "fraudulent",
	}) as Stripe.Dispute;

const topUp = (paymentIntentId = "pi_1", amountCents = 2500) =>
	addCreditsToAccount({
		accountId: "account-1",
		amountCents,
		referenceId: paymentIntentId,
		referenceType: "stripe_payment_intent",
		metadata: { amountCents },
	});

const reversals = () =>
	ledger.rows.filter(
		(row) =>
			row.referenceType === "stripe_refund" ||
			row.referenceType === "stripe_dispute",
	);

const described = (row: LedgerRow | undefined) => {
	if (!row) throw new Error("No ledger row");
	return describeLedgerRow({
		...row,
		referenceId: row.referenceId ?? null,
		referenceType: row.referenceType ?? null,
		metadata: row.metadata ?? null,
	});
};

const billing = () => getInfraBilling("app-1", undefined, new Date(ledger.now));

const addsUp = () => {
	let balance = 0;
	for (const row of ledger.rows) {
		balance += row.amountMicroCredits;
		expect(row.balanceAfterMicroCredits, row.id).toBe(balance);
	}
	expect(ledger.account.balanceMicroCredits).toBe(balance);
};

const creditCheckout = (accountId = "account-1") => ({
	type: "developer_credits",
	accountId,
});
const autoTopUp = { type: "developer_auto_top_up", accountId: "account-1" };
const checkoutPaymentTag = creditCheckoutSessionParams({
	customerId: "cus_1",
	accountId: "account-1",
	appName: "Demo",
	amountCents: 2500,
	receiptEmail: "owner@example.com",
}).payment_intent_data.metadata;

const payments: Record<
	string,
	{
		invoice?: string;
		metadata?: Record<string, string>;
		session?: Record<string, string>;
	}
> = {
	pi_1: { session: creditCheckout() },
	pi_2: { session: creditCheckout() },
	pi_3: { session: creditCheckout() },
	pi_other_account: { session: creditCheckout("account-2") },
	pi_auto: { metadata: autoTopUp },
	pi_pending: { metadata: autoTopUp },
	pi_subscription: { invoice: "in_1" },
	pi_invoiced: {
		invoice: "in_2",
		metadata: checkoutPaymentTag,
		session: creditCheckout(),
	},
	pi_pro_checkout: { session: { type: "pro", userId: "user-1" } },
	pi_unknown: {},
};

beforeEach(() => {
	resetLedger();
	mocks.ids = 0;
	mocks.listRefunds.mockReset();
	mocks.listRefunds.mockResolvedValue({ data: [] });
	mocks.retrievePaymentIntent.mockReset();
	mocks.retrievePaymentIntent.mockImplementation(async (id: string) => {
		const payment = payments[id];
		if (!payment) throw new Error(`No such payment_intent: ${id}`);
		return {
			id,
			invoice: payment.invoice ?? null,
			metadata: payment.metadata ?? {},
		};
	});
	mocks.listSessions.mockReset();
	mocks.listSessions.mockImplementation(
		async ({ payment_intent }: { payment_intent: string }) => {
			const session = payments[payment_intent]?.session;
			return { data: session ? [{ id: "cs_1", metadata: session }] : [] };
		},
	);
});

describe("a refunded top-up", () => {
	it("takes the whole grant back on a full refund, in one ledger row", async () => {
		await topUp();

		const [result] = await reverseRefundedCharge(
			charge("pi_1", [refund("re_1", 2500)]),
		);

		expect(result).toEqual({
			state: "reversed",
			deductedMicroCredits: GRANT,
			uncollectedMicroCredits: 0,
			balanceMicroCredits: 0,
		});
		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(reversals()).toHaveLength(1);
		expect(reversals()[0]).toMatchObject({
			accountId: "account-1",
			type: "refund",
			amountMicroCredits: -GRANT,
			balanceAfterMicroCredits: 0,
			referenceId: "re_1",
			referenceType: "stripe_refund",
		});
		addsUp();
	});

	it("takes back each partial refund once and never more than the grant", async () => {
		await topUp();

		await reverseRefundedCharge(charge("pi_1", [refund("re_1", 1000)]));
		expect(ledger.account.balanceMicroCredits).toBe(1_500_000);

		await reverseRefundedCharge(
			charge("pi_1", [refund("re_2", 500), refund("re_1", 1000)]),
		);
		expect(ledger.account.balanceMicroCredits).toBe(1_000_000);

		await reverseRefundedCharge(
			charge("pi_1", [
				refund("re_3", 1000),
				refund("re_2", 500),
				refund("re_1", 1000),
			]),
		);

		expect(
			reversals().map((row) => [row.referenceId, row.amountMicroCredits]),
		).toEqual([
			["re_1", -1_000_000],
			["re_2", -500_000],
			["re_3", -1_000_000],
		]);
		expect(ledger.account.balanceMicroCredits).toBe(0);
		addsUp();
	});

	it("takes back exactly the grant when the parts do not divide evenly", async () => {
		await topUp("pi_1", 1000);
		const paid = { amount: 333 };

		await reverseRefundedCharge(charge("pi_1", [refund("re_1", 111)], paid));
		await reverseRefundedCharge(
			charge("pi_1", [refund("re_1", 111), refund("re_2", 111)], paid),
		);
		await reverseRefundedCharge(
			charge(
				"pi_1",
				[refund("re_1", 111), refund("re_2", 111), refund("re_3", 111)],
				paid,
			),
		);

		expect(
			reversals().reduce((total, row) => total - row.amountMicroCredits, 0),
		).toBe(1_000_000);
		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(
			refundedShareMicroCredits({
				grantMicroCredits: 1_000_000,
				refundedCents: 111,
				chargeCents: 333,
			}),
		).toBe(333_333);
	});

	it("catches up a refund whose own event never arrived", async () => {
		await topUp();

		await reverseRefundedCharge(
			charge("pi_1", [refund("re_2", 500), refund("re_1", 1000)]),
		);

		expect(reversals().map((row) => row.referenceId)).toEqual(["re_1", "re_2"]);
		expect(ledger.account.balanceMicroCredits).toBe(1_000_000);
	});

	it("stops at zero when the credit was already spent and says how much it could not take", async () => {
		await topUp();
		ledger.account.balanceMicroCredits = 400_000;
		ledger.rows.push({
			id: "spent",
			accountId: "account-1",
			type: "transcription",
			amountMicroCredits: -2_100_000,
			balanceAfterMicroCredits: 400_000,
			referenceId: "transcript-1",
			referenceType: "developer_transcript",
			createdAt: new Date(ledger.now),
		});

		const [result] = await reverseRefundedCharge(
			charge("pi_1", [refund("re_1", 2500)]),
		);

		expect(result).toEqual({
			state: "reversed",
			deductedMicroCredits: 400_000,
			uncollectedMicroCredits: 2_100_000,
			balanceMicroCredits: 0,
		});
		expect(ledger.account.balanceMicroCredits).toBe(0);
		const row = reversals()[0];
		expect(row).toMatchObject({
			amountMicroCredits: -400_000,
			balanceAfterMicroCredits: 0,
			metadata: {
				requestedMicroCredits: GRANT,
				uncollectedMicroCredits: 2_100_000,
			},
		});
		expect(described(row)).toEqual({
			label: "Payment reversed",
			note: "Credit taken back because the payment was returned. $21.00 of it had already been spent and was not taken back.",
			reference: { kind: "Refund", value: "re_1" },
		});
		addsUp();

		const after = await billing();
		expect(after.standing.state).toBe("active");
		expect(after.admission).toMatchObject({
			allowed: false,
			reason: "insufficient_credits",
			balanceMicroCredits: 0,
		});
		expect(await transcriptStartRefusal("app-1", ledger.now)).toMatchObject({
			code: "insufficient_credits",
		});
	});

	it("records a refund that could take nothing, so a retry stays quiet", async () => {
		await topUp();
		ledger.account.balanceMicroCredits = 0;
		const event = charge("pi_1", [refund("re_1", 2500)]);

		await reverseRefundedCharge(event);
		expect(await reverseRefundedCharge(event)).toEqual([
			{ state: "duplicate" },
		]);

		expect(reversals()).toHaveLength(1);
		expect(reversals()[0]).toMatchObject({
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 0,
			metadata: { uncollectedMicroCredits: GRANT },
		});
	});

	it("writes nothing twice when the same event is delivered again", async () => {
		await topUp();
		const event = charge("pi_1", [refund("re_1", 1000)]);

		await reverseRefundedCharge(event);
		const again = await reverseRefundedCharge(event);

		expect(again).toEqual([{ state: "duplicate" }]);
		expect(reversals()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(1_500_000);
	});

	it("reverses an auto top-up the same way, from the charge alone", async () => {
		await addCreditsToAccount({
			accountId: "account-1",
			amountCents: 2500,
			referenceId: "pi_auto",
			referenceType: "auto_top_up",
		});

		await reverseRefundedCharge(
			charge("pi_auto", [refund("re_1", 2500)], { metadata: autoTopUp }),
		);

		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(reversals()).toHaveLength(1);
		expect(mocks.retrievePaymentIntent).not.toHaveBeenCalled();
		expect(mocks.listSessions).not.toHaveBeenCalled();
	});

	it("reverses a purchase whose checkout attached an invoice, by the same grant", async () => {
		await topUp("pi_invoiced");

		const refunded = await reverseRefundedCharge(
			charge("pi_invoiced", [refund("re_1", 1000)], {
				invoice: "in_2",
				metadata: checkoutPaymentTag,
			} as Partial<Stripe.Charge>),
		);
		const disputed = await reverseDisputedPayment(
			dispute("dp_1", "pi_invoiced"),
		);

		expect(refunded).toEqual([
			expect.objectContaining({
				state: "reversed",
				deductedMicroCredits: 1_000_000,
			}),
		]);
		expect(disputed).toEqual(
			expect.objectContaining({
				state: "reversed",
				deductedMicroCredits: 1_500_000,
			}),
		);
		expect(reversals().map((row) => row.metadata?.paymentIntentId)).toEqual([
			"pi_invoiced",
			"pi_invoiced",
		]);
		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(mocks.listSessions).not.toHaveBeenCalled();
		addsUp();
	});

	it("reverses an auto top-up whose charge carries no metadata", async () => {
		await addCreditsToAccount({
			accountId: "account-1",
			amountCents: 2500,
			referenceId: "pi_auto",
			referenceType: "auto_top_up",
		});

		await reverseDisputedPayment(dispute("dp_1", "pi_auto"));

		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(mocks.listSessions).not.toHaveBeenCalled();
	});

	it("takes the whole grant back when a code paid for part of it", async () => {
		await topUp();

		await reverseRefundedCharge(
			charge("pi_1", [refund("re_1", 500)], { amount: 500 }),
		);

		expect(ledger.account.balanceMicroCredits).toBe(0);
	});

	it("reads the refunds from Stripe when the event does not carry them", async () => {
		await topUp();
		mocks.listRefunds.mockResolvedValue({
			data: [refund("re_2", 700, "failed"), refund("re_1", 1000)],
		});

		await reverseRefundedCharge(charge("pi_1", null));

		expect(mocks.listRefunds).toHaveBeenCalledWith({
			charge: "ch_1",
			limit: 100,
		});
		expect(reversals().map((row) => row.referenceId)).toEqual(["re_1"]);
		expect(ledger.account.balanceMicroCredits).toBe(1_500_000);
	});
});

describe("a charge that did not buy credit", () => {
	it("ignores a Cap subscription charge, even for a customer with an Infra balance", async () => {
		await topUp();

		const results = await reverseRefundedCharge(
			charge("pi_subscription", null, {
				invoice: "in_1",
				customer: "cus_1",
			} as Partial<Stripe.Charge>),
		);
		expect(mocks.retrievePaymentIntent).not.toHaveBeenCalled();
		const disputed = await reverseDisputedPayment(
			dispute("dp_1", "pi_subscription"),
		);
		expect(mocks.retrievePaymentIntent).toHaveBeenCalledWith("pi_subscription");
		expect(mocks.listSessions).not.toHaveBeenCalled();

		expect(results).toEqual([
			{ state: "ignored", reason: "not_a_credit_payment" },
		]);
		expect(disputed).toEqual({
			state: "ignored",
			reason: "not_a_credit_payment",
		});
		expect(mocks.listRefunds).not.toHaveBeenCalled();
		expect(reversals()).toHaveLength(0);
		expect(ledger.account.balanceMicroCredits).toBe(GRANT);
		expect((await billing()).standing.state).toBe("active");
	});

	it("ignores an unknown payment and a charge with no payment", async () => {
		expect(
			await reverseRefundedCharge(charge("pi_unknown", [refund("re_1", 2500)])),
		).toEqual([{ state: "ignored", reason: "not_a_credit_payment" }]);
		expect(
			await reverseRefundedCharge(charge(null, [refund("re_1", 2500)])),
		).toEqual([{ state: "ignored", reason: "no_payment" }]);
		expect(await reverseDisputedPayment(dispute("dp_1", null))).toEqual({
			state: "ignored",
			reason: "no_payment",
		});
		expect(ledger.rows).toHaveLength(0);
	});

	it("ignores a checkout that was not for credits", async () => {
		await topUp();

		expect(
			await reverseRefundedCharge(
				charge("pi_pro_checkout", [refund("re_1", 2500)]),
			),
		).toEqual([{ state: "ignored", reason: "not_a_credit_payment" }]);
		expect(ledger.account.balanceMicroCredits).toBe(GRANT);
	});

	it("ignores a payment whose checkout names an account that does not exist", async () => {
		await topUp("pi_other_account");

		expect(
			await reverseDisputedPayment(dispute("dp_1", "pi_other_account")),
		).toEqual({ state: "ignored", reason: "not_a_credit_payment" });
		expect(reversals()).toHaveLength(0);
		expect(ledger.account.balanceMicroCredits).toBe(GRANT);
	});

	it("leaves the event for a retry when Stripe cannot be read", async () => {
		await topUp();
		mocks.retrievePaymentIntent.mockRejectedValueOnce(new Error("network"));

		await expect(
			reverseDisputedPayment(dispute("dp_1", "pi_1")),
		).rejects.toThrow("network");
		expect(reversals()).toHaveLength(0);
	});

	it("cannot touch a purchase a code covered in full", async () => {
		await addCreditsToAccount({
			accountId: "account-1",
			amountCents: 2500,
			referenceId: "cs_free",
			referenceType: "stripe_checkout_session",
		});

		expect(
			await reverseRefundedCharge(charge("pi_1", [refund("re_1", 2500)])),
		).toEqual([{ state: "grant_pending" }]);
		expect(await reverseDisputedPayment(dispute("dp_1", "pi_2"))).toEqual({
			state: "grant_pending",
		});
		expect(await reverseDisputedPayment(dispute("dp_2", "pi_unknown"))).toEqual(
			{
				state: "ignored",
				reason: "not_a_credit_payment",
			},
		);

		expect(reversals()).toHaveLength(0);
		expect(ledger.account.balanceMicroCredits).toBe(GRANT);
		expect((await billing()).standing.state).toBe("active");
	});

	it("does not count a pending or declined auto top-up as a grant", async () => {
		ledger.rows.push({
			id: "pending",
			accountId: "account-1",
			type: "topup_pending",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 0,
			referenceId: "pi_pending",
			referenceType: "auto_top_up_pending",
			createdAt: new Date(ledger.now),
		});

		expect(await reverseDisputedPayment(dispute("dp_1", "pi_pending"))).toEqual(
			{ state: "grant_pending" },
		);

		expect(reversals()).toHaveLength(0);
		expect(ledger.rows).toHaveLength(1);
	});
});

describe("an event that arrives before its grant", () => {
	it("leaves a refund unacknowledged and writes nothing, then reverses it once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const event = charge("pi_1", [refund("re_1", 1000)]);

		const early = await reverseRefundedCharge(event);

		expect(early).toEqual([{ state: "grant_pending" }]);
		expect(awaitsCreditGrant(early)).toBe(true);
		expect(ledger.rows).toHaveLength(0);
		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(mocks.listRefunds).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();

		await topUp();
		const redelivered = await reverseRefundedCharge(event);

		expect(awaitsCreditGrant(redelivered)).toBe(false);
		expect(redelivered).toMatchObject([
			{ state: "reversed", deductedMicroCredits: 1_000_000 },
		]);
		expect(await reverseRefundedCharge(event)).toEqual([
			{ state: "duplicate" },
		]);
		expect(reversals()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(1_500_000);
		addsUp();
	});

	it("leaves a dispute unacknowledged and unpaused, then reverses and pauses once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		ledger.account.autoTopUpEnabled = true;

		const early = await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		expect(early).toEqual({ state: "grant_pending" });
		expect(awaitsCreditGrant(early)).toBe(true);
		expect(ledger.rows).toHaveLength(0);
		expect(ledger.account.autoTopUpEnabled).toBe(true);
		expect((await billing()).standing.state).toBe("active");
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();

		await topUp();
		const redelivered = await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		expect(redelivered).toMatchObject({
			state: "reversed",
			deductedMicroCredits: GRANT,
		});
		expect(await reverseDisputedPayment(dispute("dp_1", "pi_1"))).toEqual({
			state: "duplicate",
		});
		expect(reversals()).toHaveLength(1);
		expect(ledger.account).toMatchObject({
			balanceMicroCredits: 0,
			autoTopUpEnabled: false,
		});
		expect((await billing()).standing).toMatchObject({
			state: "paused",
			disputed: true,
		});
	});

	it("waits for an auto top-up whose grant is not written yet", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(
			await reverseRefundedCharge(
				charge("pi_auto", [refund("re_1", 2500)], { metadata: autoTopUp }),
			),
		).toEqual([{ state: "grant_pending" }]);
		expect(ledger.rows).toHaveLength(0);
		warn.mockRestore();
	});

	it("still acknowledges a charge that never bought credit", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const subscription = await reverseRefundedCharge(
			charge("pi_subscription", null, {
				invoice: "in_1",
			} as Partial<Stripe.Charge>),
		);
		const unknown = await reverseDisputedPayment(dispute("dp_1", "pi_unknown"));
		const otherCheckout = await reverseRefundedCharge(
			charge("pi_pro_checkout", [refund("re_1", 2500)]),
		);

		expect(awaitsCreditGrant(subscription)).toBe(false);
		expect(awaitsCreditGrant(unknown)).toBe(false);
		expect(awaitsCreditGrant(otherCheckout)).toBe(false);
		expect(warn).not.toHaveBeenCalled();
		expect(ledger.rows).toHaveLength(0);
		warn.mockRestore();
	});
});

describe("a charge with more refunds than one page", () => {
	const pages = (all: Stripe.Refund[]) =>
		mocks.listRefunds.mockImplementation(
			async ({ starting_after }: { starting_after?: string }) => {
				const from = starting_after
					? all.findIndex((item) => item.id === starting_after) + 1
					: 0;
				return {
					data: all.slice(from, from + 100),
					has_more: from + 100 < all.length,
				};
			},
		);

	it("applies every refund once across pages and never passes the grant", async () => {
		await topUp();
		const all = Array.from({ length: 250 }, (_, index) =>
			refund(`re_${index + 1}`, 10),
		).reverse();
		pages(all);

		const results = await reverseRefundedCharge(charge("pi_1", null));

		expect(mocks.listRefunds).toHaveBeenCalledTimes(3);
		expect(mocks.listRefunds.mock.calls.map(([params]) => params)).toEqual([
			{ charge: "ch_1", limit: 100 },
			{ charge: "ch_1", limit: 100, starting_after: "re_151" },
			{ charge: "ch_1", limit: 100, starting_after: "re_51" },
		]);
		expect(results).toHaveLength(250);
		expect(results.every((result) => result.state === "reversed")).toBe(true);
		expect(new Set(reversals().map((row) => row.referenceId)).size).toBe(250);
		expect(
			reversals().reduce((total, row) => total - row.amountMicroCredits, 0),
		).toBe(GRANT);
		expect(ledger.account.balanceMicroCredits).toBe(0);
		addsUp();

		const again = await reverseRefundedCharge(charge("pi_1", null));
		expect(again.every((result) => result.state === "duplicate")).toBe(true);
		expect(reversals()).toHaveLength(250);
	});

	it("takes back only the grant when the pages hold a refund for all of it and more rows", async () => {
		await topUp();
		pages(
			[
				...Array.from({ length: 120 }, (_, index) =>
					refund(`re_${index + 1}`, 20),
				),
				refund("re_121", 100),
				refund("re_122", 700, "failed"),
			].reverse(),
		);

		const results = await reverseRefundedCharge(charge("pi_1", null));

		expect(results).toHaveLength(121);
		expect(
			reversals().reduce((total, row) => total - row.amountMicroCredits, 0),
		).toBe(GRANT);
		expect(ledger.account.balanceMicroCredits).toBe(0);
	});

	it("fails instead of cutting the list short, so the event is retried", async () => {
		await topUp();
		let served = 0;
		mocks.listRefunds.mockImplementation(async () => ({
			data: Array.from({ length: 100 }, () => refund(`re_${++served}`, 1)),
			has_more: true,
		}));

		await expect(reverseRefundedCharge(charge("pi_1", null))).rejects.toThrow(
			"more than 5000 refunds",
		);
		expect(reversals()).toHaveLength(0);
		expect(ledger.account.balanceMicroCredits).toBe(GRANT);
	});
});

describe("a disputed top-up", () => {
	const armed = async () => {
		await topUp();
		Object.assign(ledger.account, {
			stripeCustomerId: "cus_1",
			stripePaymentMethodId: "pm_1",
			autoTopUpEnabled: true,
			autoTopUpThresholdMicroCredits: 500_000,
			autoTopUpAmountCents: 500,
		});
	};

	it("takes the remaining grant back and switches auto top-up off", async () => {
		await armed();

		const result = await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		expect(result).toEqual({
			state: "reversed",
			deductedMicroCredits: GRANT,
			uncollectedMicroCredits: 0,
			balanceMicroCredits: 0,
		});
		expect(ledger.account).toMatchObject({
			balanceMicroCredits: 0,
			autoTopUpEnabled: false,
		});
		const row = reversals()[0];
		expect(row).toMatchObject({
			type: "adjustment",
			amountMicroCredits: -GRANT,
			balanceAfterMicroCredits: 0,
			referenceId: "dp_1",
			referenceType: "stripe_dispute",
			metadata: { reason: "fraudulent", autoTopUpSwitchedOff: true },
		});
		expect(described(row)).toEqual({
			label: "Payment disputed",
			note: "Credit taken back for a disputed payment. The app is paused and auto top-up is off until Cap reviews it.",
			reference: { kind: "Dispute", value: "dp_1" },
		});
		addsUp();
	});

	it("takes back only what a partial refund left", async () => {
		await armed();
		await reverseRefundedCharge(charge("pi_1", [refund("re_1", 1000)]));

		await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		expect(reversals().map((row) => row.amountMicroCredits)).toEqual([
			-1_000_000, -1_500_000,
		]);
		expect(ledger.account.balanceMicroCredits).toBe(0);

		expect(
			await reverseRefundedCharge(
				charge("pi_1", [refund("re_1", 1000), refund("re_2", 1500)]),
			),
		).toEqual([{ state: "duplicate" }, { state: "nothing_left" }]);
		expect(reversals()).toHaveLength(2);
	});

	it("writes nothing twice when the same dispute is delivered again", async () => {
		await armed();
		await topUp("pi_2");

		await reverseDisputedPayment(dispute("dp_1", "pi_1"));
		expect(await reverseDisputedPayment(dispute("dp_1", "pi_1"))).toEqual({
			state: "duplicate",
		});

		expect(reversals()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(GRANT);
	});

	it("pauses the app at once: no uploads, no new transcripts, no playback", async () => {
		await armed();
		await topUp("pi_2");
		expect((await billing()).admission.allowed).toBe(true);
		expect(await transcriptStartRefusal("app-1", ledger.now)).toBeNull();

		await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		const after = await billing();
		expect(ledger.account.balanceMicroCredits).toBe(GRANT);
		expect(after.standing).toEqual({
			state: "paused",
			pausesAt: new Date(ledger.now),
			disputed: true,
		});
		expect(after.admission).toMatchObject({
			allowed: false,
			reason: "out_of_credit",
			message: DISPUTED_UPLOAD_MESSAGE,
		});
		expect(infraVideoFailure(DISPUTED_UPLOAD_MESSAGE)).toBe(
			DISPUTED_UPLOAD_MESSAGE,
		);
		expect(await transcriptStartRefusal("app-1", ledger.now)).toMatchObject({
			code: "out_of_credit",
		});
	});

	it("stays paused when more credit is bought, until Cap reviews it", async () => {
		await armed();
		await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		advanceDays(1);
		await topUp("pi_3", 5000);
		expect((await billing()).standing.state).toBe("paused");
		expect((await billing()).admission.allowed).toBe(false);

		advanceDays(1);
		ledger.rows.push({
			id: "reviewed",
			accountId: "account-1",
			type: "adjustment",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: ledger.account.balanceMicroCredits,
			referenceId: "Dispute reviewed",
			referenceType: "manual",
			createdAt: new Date(ledger.now),
		});

		const restored = await billing();
		expect(restored.standing).toEqual({ state: "active", pausesAt: null });
		expect(restored.admission.allowed).toBe(true);
	});

	it("records what was already spent and still pauses", async () => {
		await armed();
		ledger.account.balanceMicroCredits = 0;

		const result = await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		expect(result).toMatchObject({
			deductedMicroCredits: 0,
			uncollectedMicroCredits: GRANT,
			balanceMicroCredits: 0,
		});
		expect(described(reversals()[0]).note).toBe(
			"Credit taken back for a disputed payment. The app is paused and auto top-up is off until Cap reviews it. $25.00 of it had already been spent and was not taken back.",
		);
		expect((await billing()).standing.state).toBe("paused");
	});
});

describe("how the rows read in the API", () => {
	it("describes both rows without passing metadata through", async () => {
		await topUp();
		await reverseRefundedCharge(charge("pi_1", [refund("re_1", 1000)]));
		await reverseDisputedPayment(dispute("dp_1", "pi_1"));

		const [refunded, disputed] = reversals().map((row) =>
			serializeLedgerRow({
				...row,
				referenceId: row.referenceId ?? null,
				referenceType: row.referenceType ?? null,
				metadata: row.metadata ?? null,
			}),
		);

		expect(refunded).toMatchObject({
			type: "refund",
			description: "Payment reversed",
			amountMicroCredits: -1_000_000,
			amountDollars: "-10.00",
			referenceType: "stripe_refund",
			referenceId: "re_1",
		});
		expect(disputed).toMatchObject({
			type: "adjustment",
			description: "Payment disputed",
			amountMicroCredits: -1_500_000,
			balanceAfterMicroCredits: 0,
			referenceType: "stripe_dispute",
			referenceId: "dp_1",
		});
		expect(refunded).not.toHaveProperty("metadata");
	});
});
