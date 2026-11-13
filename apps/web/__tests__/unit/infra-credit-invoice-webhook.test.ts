import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	constructEvent: vi.fn(),
	retrieveSubscription: vi.fn(),
	listSubscriptions: vi.fn(),
	retrieveCustomer: vi.fn(),
	updateCustomer: vi.fn(),
	dbCalls: [] as string[],
	existingGrants: [] as { id: string }[][],
	addCredits: vi.fn(),
	sendEmail: vi.fn(),
	enqueueLoopsSync: vi.fn(),
	attachSsoCheckout: vi.fn(),
	getSsoBillingForSubscription: vi.fn(),
	syncSsoSubscription: vi.fn(),
	saveCardFromCheckout: vi.fn(),
}));

const chain: Record<string, unknown> = new Proxy(
	{},
	{
		get(_target, key) {
			if (key === "then") return undefined;
			return (..._args: unknown[]) => {
				mocks.dbCalls.push(String(key));
				if (key === "limit") {
					return Promise.resolve(mocks.existingGrants.shift() ?? []);
				}
				return chain;
			};
		},
	},
);

vi.mock("@cap/database", () => ({ db: () => chain }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "id",
	nanoIdLength: 15,
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@cap/database/emails/infra-out-of-credit", () => ({
	InfraOutOfCredit: () => null,
}));
vi.mock("@cap/database/emails/infra-top-up-failed", () => ({
	InfraTopUpFailed: () => null,
}));
vi.mock("@cap/database/loops/queue", () => ({
	enqueueLoopsSync: mocks.enqueueLoopsSync,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		STRIPE_WEBHOOK_SECRET: "whsec_test",
		WEB_URL: "https://cap.test",
	}),
}));
vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return {
		...actual,
		stripe: () => ({
			webhooks: { constructEvent: mocks.constructEvent },
			subscriptions: {
				retrieve: mocks.retrieveSubscription,
				list: mocks.listSubscriptions,
			},
			customers: {
				retrieve: mocks.retrieveCustomer,
				update: mocks.updateCustomer,
			},
		}),
	};
});
vi.mock("@/lib/developer-credits", () => ({
	addCreditsToAccount: mocks.addCredits,
}));
vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_credits",
}));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/sso/billing", () => ({
	attachSsoCheckout: mocks.attachSsoCheckout,
	getSsoBillingForSubscription: mocks.getSsoBillingForSubscription,
	syncSsoSubscription: mocks.syncSsoSubscription,
}));

import { POST } from "@/app/api/webhooks/stripe/route";

const PAYMENT_INTENT = "pi_credit";
const INVOICE = "in_credit";

const session = {
	id: "cs_credit",
	object: "checkout.session",
	mode: "payment",
	customer: "cus_owner",
	subscription: null,
	invoice: INVOICE,
	payment_status: "paid",
	payment_intent: PAYMENT_INTENT,
	amount_total: 2500,
	metadata: {
		type: "developer_credits",
		appId: "app-1",
		accountId: "account-1",
		amountCents: "2500",
		userId: "user-1",
	},
};

const invoice = {
	id: INVOICE,
	object: "invoice",
	customer: "cus_owner",
	subscription: null,
	subscription_details: { metadata: null },
	billing_reason: "manual",
	description: "Cap Infra credits",
	status: "paid",
	payment_intent: PAYMENT_INTENT,
	charge: "ch_credit",
	attempt_count: 1,
	next_payment_attempt: null,
	lines: {
		data: [
			{
				id: "il_credit",
				amount: 2500,
				price: { id: "price_adhoc", product: "prod_credits" },
				quantity: 1,
			},
		],
	},
};

const paymentTag = { type: "developer_credits", accountId: "account-1" };

const paymentIntent = {
	id: PAYMENT_INTENT,
	object: "payment_intent",
	status: "succeeded",
	amount: 2500,
	amount_received: 2500,
	currency: "usd",
	invoice: INVOICE,
	metadata: paymentTag,
};

const charge = {
	id: "ch_credit",
	object: "charge",
	payment_intent: PAYMENT_INTENT,
	invoice: INVOICE,
	amount: 2500,
	metadata: paymentTag,
};

const invoicePayment = {
	id: "inpay_credit",
	object: "invoice_payment",
	invoice: INVOICE,
	payment: { type: "payment_intent", payment_intent: PAYMENT_INTENT },
};

async function deliver(type: string, object: Record<string, unknown>) {
	mocks.constructEvent.mockReturnValue({ type, data: { object } });
	return POST(
		new Request("https://cap.test/api/webhooks/stripe", {
			method: "POST",
			headers: { "Stripe-Signature": "sig_test" },
			body: "{}",
		}),
	);
}

function expectNothingElseTouched() {
	expect(mocks.syncSsoSubscription).not.toHaveBeenCalled();
	expect(mocks.getSsoBillingForSubscription).not.toHaveBeenCalled();
	expect(mocks.attachSsoCheckout).not.toHaveBeenCalled();
	expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
	expect(mocks.listSubscriptions).not.toHaveBeenCalled();
	expect(mocks.retrieveCustomer).not.toHaveBeenCalled();
	expect(mocks.updateCustomer).not.toHaveBeenCalled();
	expect(mocks.enqueueLoopsSync).not.toHaveBeenCalled();
	expect(mocks.sendEmail).not.toHaveBeenCalled();
	expect(mocks.dbCalls).not.toContain("update");
	expect(mocks.dbCalls).not.toContain("insert");
	expect(mocks.dbCalls).not.toContain("delete");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.dbCalls.length = 0;
	mocks.existingGrants.length = 0;
	mocks.addCredits.mockResolvedValue(2_500_000);
});

describe("the invoice Stripe creates for a Cap Infra credit purchase", () => {
	it("answers invoice.paid with 200 and touches no billing state", async () => {
		const response = await deliver("invoice.paid", invoice);

		expect(response.status).toBe(200);
		expect(mocks.addCredits).not.toHaveBeenCalled();
		expect(mocks.dbCalls).toEqual([]);
		expectNothingElseTouched();
	});

	it.each([
		["invoice.created", invoice],
		["invoice.finalized", invoice],
		["invoice.payment_succeeded", invoice],
		["invoice.sent", invoice],
		["invoice_payment.paid", invoicePayment],
		["charge.succeeded", charge],
		["charge.updated", charge],
	])("leaves %s without side effects", async (type, object) => {
		await deliver(type, object);

		expect(mocks.addCredits).not.toHaveBeenCalled();
		expect(mocks.dbCalls).toEqual([]);
		expectNothingElseTouched();
	});

	it("grants the purchase once, from checkout.session.completed, across every event Stripe sends for it", async () => {
		const events: [string, Record<string, unknown>][] = [
			["payment_intent.created", { ...paymentIntent, status: "processing" }],
			["payment_intent.succeeded", paymentIntent],
			["charge.succeeded", charge],
			["invoice.created", invoice],
			["invoice.finalized", invoice],
			["charge.updated", charge],
			["checkout.session.completed", session],
			["invoice.payment_succeeded", invoice],
			["invoice.paid", invoice],
			["invoice.sent", invoice],
			["invoice_payment.paid", invoicePayment],
		];
		for (const [type, object] of events) {
			await deliver(type, object);
		}
		mocks.existingGrants.push([{ id: "txn_credit" }]);
		await deliver("invoice.paid", invoice);
		await deliver("checkout.session.completed", session);

		expect(mocks.addCredits).toHaveBeenCalledTimes(1);
		expect(mocks.addCredits).toHaveBeenCalledWith({
			accountId: "account-1",
			amountCents: 2500,
			referenceId: PAYMENT_INTENT,
			referenceType: "stripe_payment_intent",
			metadata: { amountCents: 2500, stripeSessionId: "cs_credit" },
		});
		expectNothingElseTouched();
	});
});
