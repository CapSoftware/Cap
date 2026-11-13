import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: null as unknown,
	ids: 0,
	emailsEnabled: false,
	createPaymentIntent: vi.fn(),
	retrieveSetupIntent: vi.fn(),
	retrievePaymentMethod: vi.fn(),
	detachPaymentMethod: vi.fn(),
	sendEmail: vi.fn(),
	after: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));

vi.mock("@cap/database", () => ({ db: () => mocks.db }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `row-${++mocks.ids}`,
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		WEB_URL: "https://cap.test",
		CAP_INFRA_BILLING_EMAILS: mocks.emailsEnabled,
	}),
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		paymentIntents: { create: mocks.createPaymentIntent },
		setupIntents: { retrieve: mocks.retrieveSetupIntent },
		paymentMethods: {
			detach: mocks.detachPaymentMethod,
			retrieve: mocks.retrievePaymentMethod,
		},
	}),
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@cap/database/emails/infra-out-of-credit", () => ({
	InfraOutOfCredit: (props: unknown) => ({ template: "out-of-credit", props }),
}));
vi.mock("@cap/database/emails/infra-top-up-failed", () => ({
	InfraTopUpFailed: (props: unknown) => ({ template: "top-up-failed", props }),
}));
vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_test",
}));

import type Stripe from "stripe";
import {
	AUTO_TOP_UP_DAILY_LIMIT,
	autoTopUpFailureText,
	autoTopUpIdempotencyKey,
	autoTopUpSettingsError,
	getAutoTopUpFailure,
	runAutoTopUp,
	runDueAutoTopUps,
	saveCardFromCheckout,
	scheduleAutoTopUp,
	settleAutoTopUpPaymentIntent,
} from "@/lib/infra-auto-top-up";
import {
	sendInfraOutOfCreditEmail,
	sendInfraTopUpFailedEmail,
} from "@/lib/infra-billing-emails";
import { fakeDb, ledger, resetLedger } from "./infra-billing-fake-db";

mocks.db = fakeDb;

const HOUR_MS = 60 * 60 * 1000;
const now = () => new Date(ledger.now);
const later = (hours: number) => {
	ledger.now = new Date(ledger.now.getTime() + hours * HOUR_MS);
};

const intent = (
	id: string,
	status: Stripe.PaymentIntent.Status,
	extra: Partial<Stripe.PaymentIntent> = {},
) =>
	({
		id,
		status,
		amount: 500,
		amount_received: status === "succeeded" ? 500 : 0,
		currency: "usd",
		metadata: {
			type: "developer_auto_top_up",
			accountId: "account-1",
			period: "2026-11-11",
		},
		last_payment_error: null,
		...extra,
	}) as Stripe.PaymentIntent;

const decline = (id: string, declineCode: string) =>
	Object.assign(new Error("Your card was declined."), {
		type: "StripeCardError",
		code: "card_declined",
		decline_code: declineCode,
		payment_intent: { id },
	});

const arm = () => {
	Object.assign(ledger.account, {
		balanceMicroCredits: 30_000,
		stripeCustomerId: "cus_1",
		stripePaymentMethodId: "pm_1",
		autoTopUpEnabled: true,
		autoTopUpThresholdMicroCredits: 500_000,
		autoTopUpAmountCents: 500,
	});
};

const topUps = () =>
	ledger.rows.filter((row) => row.referenceType === "auto_top_up");
const failures = () =>
	ledger.rows.filter((row) => row.referenceType === "auto_top_up_failed");

beforeEach(() => {
	resetLedger();
	arm();
	mocks.emailsEnabled = false;
	mocks.createPaymentIntent.mockReset();
	mocks.createPaymentIntent.mockResolvedValue(intent("pi_1", "succeeded"));
	mocks.sendEmail.mockReset();
	mocks.sendEmail.mockResolvedValue({ data: { id: "email-1" }, error: null });
	mocks.retrieveSetupIntent.mockReset();
	mocks.retrieveSetupIntent.mockResolvedValue({
		status: "succeeded",
		payment_method: { id: "pm_new", customer: "cus_2", created: 2000 },
	});
	mocks.retrievePaymentMethod.mockReset();
	mocks.retrievePaymentMethod.mockResolvedValue({ id: "pm_1", created: 1000 });
	mocks.detachPaymentMethod.mockReset();
	mocks.detachPaymentMethod.mockResolvedValue({});
});

describe("auto top-up settings", () => {
	const valid = {
		enabled: true,
		thresholdMicroCredits: 500_000,
		amountCents: 2500,
		hasCard: true,
	};

	it("accepts a threshold from $1 to $1,000 and an amount from $5 to $1,000", () => {
		expect(autoTopUpSettingsError(valid)).toBe(null);
		expect(
			autoTopUpSettingsError({ ...valid, thresholdMicroCredits: 100_000 }),
		).toBe(null);
		expect(autoTopUpSettingsError({ ...valid, amountCents: 500 })).toBe(null);
		expect(autoTopUpSettingsError({ ...valid, amountCents: 100_000 })).toBe(
			null,
		);
	});

	it("refuses to switch on without a saved card", () => {
		expect(autoTopUpSettingsError({ ...valid, hasCard: false })).toBe(
			"Save a card before switching auto top-up on",
		);
	});

	it("refuses amounts and thresholds outside the range", () => {
		for (const amountCents of [0, 499, 100_001, 12.5, Number.NaN]) {
			expect(autoTopUpSettingsError({ ...valid, amountCents })).toContain(
				"amount",
			);
		}
		for (const thresholdMicroCredits of [0, 99_999, 100_000_001, -1]) {
			expect(
				autoTopUpSettingsError({ ...valid, thresholdMicroCredits }),
			).toContain("threshold");
		}
	});

	it("always allows switching off", () => {
		expect(
			autoTopUpSettingsError({
				enabled: false,
				thresholdMicroCredits: 0,
				amountCents: 0,
				hasCard: false,
			}),
		).toBe(null);
	});

	it("keys each charge by account, attempt and the exact request", () => {
		const request = { amount: 500, customer: "cus_1" };
		const key = autoTopUpIdempotencyKey("account-1", 3, request);

		expect(key).toMatch(/^infra-auto-top-up:account-1:3:[0-9a-f]{24}$/);
		expect(autoTopUpIdempotencyKey("account-1", 3, { ...request })).toBe(key);
		expect(autoTopUpIdempotencyKey("account-1", 4, request)).not.toBe(key);
		expect(
			autoTopUpIdempotencyKey("account-1", 3, { ...request, amount: 600 }),
		).not.toBe(key);
	});

	it("explains a decline in plain words", () => {
		expect(autoTopUpFailureText("authentication_required")).toContain("bank");
		expect(autoTopUpFailureText("insufficient_funds")).toContain(
			"insufficient funds",
		);
		expect(autoTopUpFailureText(null)).toBe("the card was declined");
	});
});

describe("auto top-up charge", () => {
	it("never charges an account outside the preview list", async () => {
		ledger.account.email = "someone@example.com";

		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "skipped",
			reason: "not_allowed",
		});
		expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
		expect(ledger.rows).toHaveLength(0);
		expect(ledger.account.autoTopUpEnabled).toBe(true);
	});

	it("does nothing when switched off, without a card, misconfigured or above the threshold", async () => {
		ledger.account.autoTopUpEnabled = false;
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "disabled",
		});

		arm();
		ledger.account.stripePaymentMethodId = null;
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "no_card",
		});

		arm();
		ledger.account.autoTopUpAmountCents = 100;
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "invalid_settings",
		});

		arm();
		ledger.account.balanceMicroCredits = 500_000;
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "above_threshold",
		});

		arm();
		ledger.account.exists = false;
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "not_found",
		});

		expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
	});

	it("does not charge the card of an app whose payment was disputed", async () => {
		arm();
		ledger.rows.push({
			id: "disputed",
			accountId: "account-1",
			type: "adjustment",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 30_000,
			referenceId: "dp_1",
			referenceType: "stripe_dispute",
			createdAt: new Date(ledger.now),
		});

		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "skipped",
			reason: "disputed",
		});
		expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
	});
	it("charges the saved card off session and grants credit keyed by the payment intent", async () => {
		const result = await runAutoTopUp("account-1", now());

		expect(result).toEqual({
			state: "succeeded",
			paymentIntentId: "pi_1",
			balanceMicroCredits: 530_000,
		});
		expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
		const [params, options] = mocks.createPaymentIntent.mock.calls[0] ?? [];
		expect(params).toMatchObject({
			amount: 500,
			currency: "usd",
			customer: "cus_1",
			payment_method: "pm_1",
			off_session: true,
			confirm: true,
			metadata: {
				type: "developer_auto_top_up",
				accountId: "account-1",
				sequence: "0",
			},
		});
		expect(options).toEqual({
			idempotencyKey: autoTopUpIdempotencyKey("account-1", 0, params),
		});
		expect(ledger.account.balanceMicroCredits).toBe(530_000);
		expect(topUps()).toEqual([
			expect.objectContaining({
				type: "topup",
				amountMicroCredits: 500_000,
				balanceAfterMicroCredits: 530_000,
				referenceId: "pi_1",
			}),
		]);
	});

	it("asks Stripe to email the receipt to the account owner", async () => {
		await runAutoTopUp("account-1", now());

		const [params] = mocks.createPaymentIntent.mock.calls[0] ?? [];
		expect(params.receipt_email).toBe(ledger.account.email);
	});

	it("grants once when the webhook also reports the same payment", async () => {
		await runAutoTopUp("account-1", now());

		expect(
			await settleAutoTopUpPaymentIntent(
				intent("pi_1", "succeeded"),
				"succeeded",
			),
		).toBe(true);
		await settleAutoTopUpPaymentIntent(
			intent("pi_1", "succeeded"),
			"succeeded",
		);

		expect(topUps()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(530_000);
	});

	it("tops up again the same day once the balance falls below the threshold again", async () => {
		await runAutoTopUp("account-1", now());
		later(0.1);
		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "skipped",
			reason: "above_threshold",
		});

		ledger.account.balanceMicroCredits = 10;
		mocks.createPaymentIntent.mockResolvedValue(intent("pi_2", "succeeded"));
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			state: "succeeded",
			paymentIntentId: "pi_2",
		});

		const [first, second] = mocks.createPaymentIntent.mock.calls;
		expect(second?.[0].metadata.sequence).toBe("1");
		expect(second?.[1].idempotencyKey).not.toBe(first?.[1].idempotencyKey);
		expect(topUps()).toHaveLength(2);
		expect(now().toISOString().slice(0, 10)).toBe("2026-11-11");
	});

	it("repeats the same key when retried before the attempt settles", async () => {
		mocks.createPaymentIntent.mockRejectedValueOnce(
			Object.assign(new Error("network"), { type: "StripeConnectionError" }),
		);
		expect(await runAutoTopUp("account-1", now())).toEqual({ state: "error" });
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			state: "succeeded",
		});

		const [first, retry] = mocks.createPaymentIntent.mock.calls;
		expect(retry?.[1].idempotencyKey).toBe(first?.[1].idempotencyKey);
		expect(topUps()).toHaveLength(1);
	});

	it("treats a payment already being made under the same key as in progress", async () => {
		mocks.createPaymentIntent.mockRejectedValue(
			Object.assign(new Error("in use"), {
				type: "StripeInvalidRequestError",
				code: "idempotency_key_in_use",
				statusCode: 409,
			}),
		);

		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "skipped",
			reason: "in_progress",
		});
		expect(ledger.account.autoTopUpEnabled).toBe(true);
		expect(ledger.rows).toHaveLength(0);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it(`stops at ${AUTO_TOP_UP_DAILY_LIMIT} automatic top-ups in any 24 hours, then waits`, async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 1; i <= AUTO_TOP_UP_DAILY_LIMIT; i++) {
			ledger.account.balanceMicroCredits = 10;
			mocks.createPaymentIntent.mockResolvedValue(
				intent(`pi_${i}`, "succeeded"),
			);
			expect(await runAutoTopUp("account-1", now())).toMatchObject({
				state: "succeeded",
			});
			later(1);
		}

		ledger.account.balanceMicroCredits = 10;
		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "skipped",
			reason: "daily_limit",
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(
			AUTO_TOP_UP_DAILY_LIMIT,
		);

		later(14.5);
		mocks.createPaymentIntent.mockResolvedValue(intent("pi_next", "succeeded"));
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			state: "succeeded",
			paymentIntentId: "pi_next",
		});
		warn.mockRestore();
	});

	it("grants nothing for a processing payment, then once when it succeeds", async () => {
		mocks.createPaymentIntent.mockResolvedValue(intent("pi_1", "processing"));

		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "pending",
			paymentIntentId: "pi_1",
		});
		expect(ledger.account.balanceMicroCredits).toBe(30_000);
		expect(ledger.rows).toEqual([
			expect.objectContaining({
				type: "topup_pending",
				amountMicroCredits: 0,
				balanceAfterMicroCredits: 30_000,
				referenceId: "pi_1",
				referenceType: "auto_top_up_pending",
			}),
		]);

		await settleAutoTopUpPaymentIntent(
			intent("pi_1", "succeeded"),
			"succeeded",
		);
		await settleAutoTopUpPaymentIntent(
			intent("pi_1", "succeeded"),
			"succeeded",
		);

		expect(topUps()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(530_000);
	});

	it("does not start a second payment after a processing one, even on the next UTC day", async () => {
		ledger.now = new Date("2026-11-11T23:50:00Z");
		mocks.createPaymentIntent.mockResolvedValue(intent("pi_1", "processing"));
		await runAutoTopUp("account-1", now());
		await runAutoTopUp("account-1", now());

		later(0.5);
		expect(now().toISOString().slice(0, 10)).toBe("2026-11-12");
		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "skipped",
			reason: "awaiting_payment",
		});
		later(23);
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "awaiting_payment",
		});

		expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
		expect(ledger.rows).toHaveLength(1);
	});

	it("keeps a decline visible when the webhook settles before the pending record is written", async () => {
		mocks.createPaymentIntent.mockImplementation(async () => {
			await settleAutoTopUpPaymentIntent(
				intent("pi_1", "requires_payment_method", {
					last_payment_error: {
						decline_code: "insufficient_funds",
					} as Stripe.PaymentIntent.LastPaymentError,
				}),
				"failed",
			);
			return intent("pi_1", "processing");
		});

		await runAutoTopUp("account-1", now());

		expect(ledger.rows.map((row) => row.type)).toEqual(["topup_failed"]);
		expect(ledger.account.autoTopUpEnabled).toBe(false);
		expect(await getAutoTopUpFailure("account-1")).toMatchObject({
			reason: "insufficient_funds",
		});
	});

	it("shows the last settled result even when a pending record is newer", async () => {
		mocks.createPaymentIntent.mockRejectedValue(
			decline("pi_declined", "card_declined"),
		);
		await runAutoTopUp("account-1", now());
		ledger.rows.push({
			id: "pending-later",
			accountId: "account-1",
			type: "topup_pending",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 30_000,
			referenceId: "pi_other",
			referenceType: "auto_top_up_pending",
			createdAt: new Date(ledger.now.getTime() + 1000),
		});

		expect(await getAutoTopUpFailure("account-1")).toMatchObject({
			reason: "card_declined",
		});
	});

	it("switches auto top-up off and adds no credit when the card is declined", async () => {
		mocks.createPaymentIntent.mockRejectedValue(
			decline("pi_declined", "authentication_required"),
		);

		const result = await runAutoTopUp("account-1", now());

		expect(result).toEqual({
			state: "failed",
			reason: "authentication_required",
		});
		expect(ledger.account.balanceMicroCredits).toBe(30_000);
		expect(ledger.account.autoTopUpEnabled).toBe(false);
		expect(topUps()).toHaveLength(0);
		expect(failures()).toEqual([
			expect.objectContaining({
				type: "topup_failed",
				amountMicroCredits: 0,
				balanceAfterMicroCredits: 30_000,
				referenceId: "pi_declined",
				metadata: expect.objectContaining({
					amountCents: 500,
					reason: "authentication_required",
				}),
			}),
		]);
		expect(await getAutoTopUpFailure("account-1")).toEqual({
			failedAt: now(),
			reason: "authentication_required",
		});
	});

	it("records a decline once when the webhook reports it too", async () => {
		mocks.createPaymentIntent.mockRejectedValue(
			decline("pi_declined", "insufficient_funds"),
		);
		await runAutoTopUp("account-1", now());

		const failed = intent("pi_declined", "requires_payment_method", {
			last_payment_error: {
				decline_code: "insufficient_funds",
			} as Stripe.PaymentIntent.LastPaymentError,
		});
		await settleAutoTopUpPaymentIntent(failed, "failed");
		await settleAutoTopUpPaymentIntent(failed, "failed");

		expect(failures()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(30_000);
	});

	it("does not try again within 24 hours of a decline, even if switched back on", async () => {
		mocks.createPaymentIntent.mockRejectedValue(
			decline("pi_declined", "card_declined"),
		);
		await runAutoTopUp("account-1", now());

		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "disabled",
		});
		ledger.account.autoTopUpEnabled = true;
		later(2);
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "recent_decline",
		});
		later(21.9);
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			reason: "recent_decline",
		});
		expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);

		later(0.2);
		mocks.createPaymentIntent.mockResolvedValue(intent("pi_2", "succeeded"));
		expect(await runAutoTopUp("account-1", now())).toMatchObject({
			state: "succeeded",
			paymentIntentId: "pi_2",
		});
		const [declined, next] = mocks.createPaymentIntent.mock.calls;
		expect(next?.[1].idempotencyKey).not.toBe(declined?.[1].idempotencyKey);
	});

	it("treats a charge that needs the customer as a failure", async () => {
		mocks.createPaymentIntent.mockResolvedValue(
			intent("pi_1", "requires_action"),
		);

		expect(await runAutoTopUp("account-1", now())).toEqual({
			state: "failed",
			reason: "requires_action",
		});
		expect(ledger.account.autoTopUpEnabled).toBe(false);
		expect(ledger.account.balanceMicroCredits).toBe(30_000);
	});

	it("leaves everything alone when the payment provider cannot be reached", async () => {
		mocks.createPaymentIntent.mockRejectedValue(
			Object.assign(new Error("network"), { type: "StripeConnectionError" }),
		);

		expect(await runAutoTopUp("account-1", now())).toEqual({ state: "error" });
		expect(ledger.account.autoTopUpEnabled).toBe(true);
		expect(ledger.rows).toHaveLength(0);
	});

	it("ignores payments that are not auto top-ups or did not settle in dollars", async () => {
		const other = intent("pi_other", "succeeded", { metadata: {} });
		expect(await settleAutoTopUpPaymentIntent(other, "succeeded")).toBe(false);
		expect(await settleAutoTopUpPaymentIntent(other, "failed")).toBe(false);
		expect(
			await settleAutoTopUpPaymentIntent(
				intent("pi_eur", "succeeded", { currency: "eur" }),
				"succeeded",
			),
		).toBe(false);
		expect(
			await settleAutoTopUpPaymentIntent(
				intent("pi_pending", "processing"),
				"succeeded",
			),
		).toBe(false);
		expect(ledger.rows).toHaveLength(0);
		expect(ledger.account.autoTopUpEnabled).toBe(true);
	});

	it("forgets an old decline once a later charge succeeds", async () => {
		mocks.createPaymentIntent.mockRejectedValueOnce(
			decline("pi_declined", "card_declined"),
		);
		await runAutoTopUp("account-1", now());
		ledger.account.autoTopUpEnabled = true;
		later(25);

		await runAutoTopUp("account-1", now());

		expect(await getAutoTopUpFailure("account-1")).toBe(null);
	});
});

describe("auto top-up after a charge", () => {
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const outsideRequest = () => {
		throw new Error("`after` was called outside a request scope");
	};

	beforeEach(() => {
		mocks.after.mockReset();
	});

	it("waits until the response is sent, then tops up the account", async () => {
		const tasks: (() => Promise<void>)[] = [];
		mocks.after.mockImplementation((task: () => Promise<void>) => {
			tasks.push(task);
		});

		scheduleAutoTopUp({ accountId: "account-1" });
		await settle();
		expect(mocks.createPaymentIntent).not.toHaveBeenCalled();

		await tasks[0]?.();
		expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
		expect(topUps()).toHaveLength(1);
	});

	it("finds the account from the app", async () => {
		const tasks: (() => Promise<void>)[] = [];
		mocks.after.mockImplementation((task: () => Promise<void>) => {
			tasks.push(task);
		});

		scheduleAutoTopUp({ appId: "app-1" });
		await tasks[0]?.();

		expect(mocks.createPaymentIntent.mock.calls[0]?.[0].metadata).toMatchObject(
			{ accountId: "account-1", appId: "app-1" },
		);
	});

	it("still tops up outside a request", async () => {
		mocks.after.mockImplementation(outsideRequest);

		scheduleAutoTopUp({ accountId: "account-1" });
		await vi.waitFor(() => expect(topUps()).toHaveLength(1));
	});

	it("never throws into the caller and logs what went wrong", async () => {
		mocks.after.mockImplementation(outsideRequest);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const broken = {
			...fakeDb,
			select: () => {
				throw new Error("database unavailable");
			},
		};
		mocks.db = broken;

		expect(() => scheduleAutoTopUp({ accountId: "account-1" })).not.toThrow();
		await vi.waitFor(() =>
			expect(errors).toHaveBeenCalledWith(
				"[infra-billing] Auto top-up after a charge failed",
				expect.objectContaining({ target: { accountId: "account-1" } }),
			),
		);
		expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
		mocks.db = fakeDb;
		errors.mockRestore();
	});
});

describe("saving a card from checkout", () => {
	const session = (extra: Partial<Stripe.Checkout.Session> = {}) =>
		({
			mode: "setup",
			customer: "cus_2",
			setup_intent: "seti_1",
			metadata: { type: "developer_card", accountId: "account-1" },
			...extra,
		}) as Stripe.Checkout.Session;

	it("stores the customer and card, and leaves auto top-up as it was", async () => {
		ledger.account.stripePaymentMethodId = null;
		ledger.account.autoTopUpEnabled = false;

		expect(await saveCardFromCheckout(session())).toBe(true);

		expect(mocks.retrieveSetupIntent).toHaveBeenCalledWith("seti_1", {
			expand: ["payment_method"],
		});
		expect(ledger.account).toMatchObject({
			stripeCustomerId: "cus_2",
			stripePaymentMethodId: "pm_new",
			autoTopUpEnabled: false,
		});
		expect(mocks.detachPaymentMethod).not.toHaveBeenCalled();
	});

	it("replaces an older card and detaches it", async () => {
		expect(await saveCardFromCheckout(session())).toBe(true);

		expect(ledger.account.stripePaymentMethodId).toBe("pm_new");
		expect(mocks.detachPaymentMethod).toHaveBeenCalledWith("pm_1");
	});

	it("does nothing when the same checkout is delivered again", async () => {
		await saveCardFromCheckout(session());
		mocks.detachPaymentMethod.mockClear();

		expect(await saveCardFromCheckout(session())).toBe(true);

		expect(ledger.account.stripePaymentMethodId).toBe("pm_new");
		expect(mocks.detachPaymentMethod).not.toHaveBeenCalled();
	});

	it("ignores a replayed older checkout so it cannot roll back a newer card", async () => {
		ledger.account.stripeCustomerId = "cus_2";
		ledger.account.stripePaymentMethodId = "pm_newer";
		mocks.retrievePaymentMethod.mockResolvedValue({
			id: "pm_newer",
			created: 3000,
		});

		expect(await saveCardFromCheckout(session())).toBe(false);

		expect(ledger.account.stripePaymentMethodId).toBe("pm_newer");
		expect(mocks.detachPaymentMethod).not.toHaveBeenCalled();
	});

	it("ignores a replayed checkout whose card was since removed", async () => {
		ledger.account.stripePaymentMethodId = null;
		mocks.retrieveSetupIntent.mockResolvedValue({
			status: "succeeded",
			payment_method: { id: "pm_new", customer: null, created: 2000 },
		});

		expect(await saveCardFromCheckout(session())).toBe(false);

		expect(ledger.account.stripePaymentMethodId).toBe(null);
	});

	it("stores nothing unless the setup succeeded for a known account", async () => {
		mocks.retrieveSetupIntent.mockResolvedValueOnce({
			status: "requires_payment_method",
			payment_method: null,
		});
		expect(await saveCardFromCheckout(session())).toBe(false);
		expect(await saveCardFromCheckout(session({ mode: "payment" }))).toBe(
			false,
		);
		expect(await saveCardFromCheckout(session({ metadata: {} }))).toBe(false);
		ledger.account.exists = false;
		expect(await saveCardFromCheckout(session())).toBe(false);
		ledger.account.exists = true;

		expect(ledger.account.stripePaymentMethodId).toBe("pm_1");
		expect(ledger.account.stripeCustomerId).toBe("cus_1");
	});
});

describe("auto top-up sweep", () => {
	it("charges accounts under their threshold and reports the outcome", async () => {
		expect(await runDueAutoTopUps(now())).toEqual({
			attempted: 1,
			succeeded: 1,
			failed: 0,
		});
		expect(await runDueAutoTopUps(now())).toEqual({
			attempted: 0,
			succeeded: 0,
			failed: 0,
		});
		expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
	});

	it("counts a decline", async () => {
		mocks.createPaymentIntent.mockRejectedValue(
			decline("pi_declined", "card_declined"),
		);

		expect(await runDueAutoTopUps(now())).toEqual({
			attempted: 1,
			succeeded: 0,
			failed: 1,
		});
	});
});

describe("billing emails", () => {
	const outOfCredit = () =>
		sendInfraOutOfCreditEmail({
			accountId: "account-1",
			shortSince: new Date("2026-11-11T06:41:00Z"),
			pausesAt: new Date("2026-11-18T06:41:00Z"),
		});
	const topUpFailed = () =>
		sendInfraTopUpFailedEmail({
			accountId: "account-1",
			referenceId: "pi_declined",
			amountCents: 500,
		});

	it("sends nothing while the switch is off", async () => {
		expect(await outOfCredit()).toBe(false);
		expect(await topUpFailed()).toBe(false);
		mocks.createPaymentIntent.mockRejectedValue(
			decline("pi_declined", "card_declined"),
		);
		await runAutoTopUp("account-1", now());

		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it("sends each notice once per event when the switch is on", async () => {
		mocks.emailsEnabled = true;

		expect(await outOfCredit()).toBe(true);
		expect(await topUpFailed()).toBe(true);

		expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
		expect(mocks.sendEmail.mock.calls[0]?.[0]).toMatchObject({
			email: "richie@cap.so",
			idempotencyKey: "infra-out-of-credit-account-1-2026-11-11",
			react: {
				template: "out-of-credit",
				props: {
					pausesOn: "November 18",
					billingUrl: "https://cap.test/dashboard/infra/app-1/billing",
				},
			},
		});
		expect(mocks.sendEmail.mock.calls[1]?.[0]).toMatchObject({
			email: "richie@cap.so",
			idempotencyKey: "infra-top-up-failed-account-1-pi_declined",
			react: { template: "top-up-failed", props: { amount: "$5.00" } },
		});
	});

	it("emails the owner when a charge is declined and the switch is on", async () => {
		mocks.emailsEnabled = true;
		mocks.createPaymentIntent.mockRejectedValue(
			decline("pi_declined", "card_declined"),
		);

		await runAutoTopUp("account-1", now());
		await settleAutoTopUpPaymentIntent(
			intent("pi_declined", "requires_payment_method"),
			"failed",
		);

		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
	});

	it("never emails an account outside the preview list", async () => {
		mocks.emailsEnabled = true;
		ledger.account.email = "someone@example.com";

		expect(await outOfCredit()).toBe(false);
		expect(await topUpFailed()).toBe(false);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});
});
