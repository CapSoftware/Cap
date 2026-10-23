import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	constructEvent: vi.fn(),
	retrieveSubscription: vi.fn(),
	retrieveCustomer: vi.fn(),
	dbUpdate: vi.fn(),
	sendEmail: vi.fn(),
	attachSsoCheckout: vi.fn(),
	getSsoBillingForSubscription: vi.fn(),
	syncSsoSubscription: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: () => ({ update: mocks.dbUpdate }) }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@cap/database/schema", () => ({
	developerCreditTransactions: {},
	signedBaas: {},
	users: {},
	organizations: {},
}));
vi.mock("@cap/env", () => ({
	buildEnv: {},
	serverEnv: () => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" }),
}));
vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return {
		...actual,
		stripe: () => ({
			webhooks: { constructEvent: mocks.constructEvent },
			subscriptions: { retrieve: mocks.retrieveSubscription },
			customers: { retrieve: mocks.retrieveCustomer },
		}),
	};
});
vi.mock("@/lib/developer-credits", () => ({ addCreditsToAccount: vi.fn() }));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/sso/billing", () => ({
	attachSsoCheckout: mocks.attachSsoCheckout,
	getSsoBillingForSubscription: mocks.getSsoBillingForSubscription,
	syncSsoSubscription: mocks.syncSsoSubscription,
}));

import {
	STRIPE_SAML_SSO_LEGACY_PRICE_ID,
	STRIPE_SAML_SSO_PRICE_ID,
	STRIPE_SAML_SSO_PRODUCT_ID,
} from "@cap/utils";
import { POST } from "@/app/api/webhooks/stripe/route";

function subscription(priceId = STRIPE_SAML_SSO_PRICE_ID) {
	return {
		id: "sub_sso",
		customer: "cus_owner",
		status: "active",
		metadata: {},
		items: { data: [{ price: { id: priceId }, quantity: 1 }] },
	};
}

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

function expectProUntouched() {
	expect(mocks.retrieveCustomer).not.toHaveBeenCalled();
	expect(mocks.dbUpdate).not.toHaveBeenCalled();
	expect(mocks.sendEmail).not.toHaveBeenCalled();
}

describe("organization-scoped SAML SSO webhooks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.attachSsoCheckout.mockResolvedValue(null);
		mocks.getSsoBillingForSubscription.mockResolvedValue(null);
		mocks.syncSsoSubscription.mockResolvedValue(null);
	});

	it.each([
		"customer.subscription.created",
		"customer.subscription.updated",
		"customer.subscription.deleted",
	])("routes %s without overwriting Pro", async (eventType) => {
		for (const priceId of [
			STRIPE_SAML_SSO_PRICE_ID,
			STRIPE_SAML_SSO_LEGACY_PRICE_ID,
		]) {
			const response = await deliver(eventType, subscription(priceId));
			expect(response.status).toBe(200);
			expect(mocks.syncSsoSubscription).toHaveBeenLastCalledWith("sub_sso");
		}
		expectProUntouched();
	});

	it("isolates an SSO product even when its price is not approved for access", async () => {
		const response = await deliver("customer.subscription.updated", {
			...subscription(),
			items: {
				data: [
					{ price: { id: "price_other", product: STRIPE_SAML_SSO_PRODUCT_ID } },
				],
			},
		});
		expect(response.status).toBe(200);
		expect(mocks.syncSsoSubscription).toHaveBeenCalledWith("sub_sso");
		expectProUntouched();
	});

	it("isolates metadata-only SSO without granting Pro", async () => {
		const response = await deliver("customer.subscription.updated", {
			...subscription("price_unknown"),
			metadata: { type: "saml_sso" },
		});
		expect(response.status).toBe(200);
		expect(mocks.syncSsoSubscription).toHaveBeenCalledWith("sub_sso");
		expectProUntouched();
	});

	it.each(["customer.subscription.updated", "customer.subscription.deleted"])(
		"keeps a persisted SSO binding out of Pro handling after price removal during %s",
		async (eventType) => {
			mocks.getSsoBillingForSubscription.mockResolvedValue({
				organizationId: "org_owner",
			});
			const response = await deliver(eventType, subscription("price_changed"));
			expect(response.status).toBe(200);
			expect(mocks.syncSsoSubscription).toHaveBeenCalledWith("sub_sso");
			expectProUntouched();
		},
	);

	it.each([STRIPE_SAML_SSO_PRICE_ID, STRIPE_SAML_SSO_LEGACY_PRICE_ID])(
		"recognizes an externally paid checkout by SSO price %s",
		async (priceId) => {
			mocks.retrieveSubscription.mockResolvedValue(subscription(priceId));
			const response = await deliver("checkout.session.completed", {
				id: "cs_external",
				subscription: "sub_sso",
				customer: "cus_owner",
				payment_status: "paid",
			});
			expect(response.status).toBe(200);
			expect(mocks.attachSsoCheckout).toHaveBeenCalledWith("cs_external");
			expectProUntouched();
		},
	);

	it.each([
		"checkout.session.completed",
		"checkout.session.async_payment_succeeded",
	])(
		"reconciles org-bound %s through payment verification",
		async (eventType) => {
			const response = await deliver(eventType, {
				id: "cs_sso",
				subscription: "sub_sso",
				metadata: { type: "saml_sso", organizationId: "org_owner" },
			});
			expect(response.status).toBe(200);
			expect(mocks.attachSsoCheckout).toHaveBeenCalledWith("cs_sso");
			expectProUntouched();
		},
	);

	it.each(["invoice.paid", "invoice.payment_failed"])(
		"synchronizes %s without Pro dunning",
		async (eventType) => {
			const response = await deliver(eventType, {
				id: "in_sso",
				subscription: "sub_sso",
				billing_reason: "subscription_cycle",
				attempt_count: 1,
				next_payment_attempt: null,
				lines: { data: [{ price: { id: STRIPE_SAML_SSO_LEGACY_PRICE_ID } }] },
			});
			expect(response.status).toBe(200);
			expect(mocks.syncSsoSubscription).toHaveBeenCalledWith("sub_sso");
			expectProUntouched();
		},
	);

	it("does not send Pro dunning for a persisted SSO binding after price removal", async () => {
		mocks.getSsoBillingForSubscription.mockResolvedValue({
			organizationId: "org_owner",
		});
		const response = await deliver("invoice.payment_failed", {
			id: "in_sso",
			subscription: "sub_sso",
			billing_reason: "subscription_cycle",
			attempt_count: 1,
			lines: { data: [{ price: { id: "price_changed" } }] },
		});
		expect(response.status).toBe(200);
		expect(mocks.syncSsoSubscription).toHaveBeenCalledWith("sub_sso");
		expectProUntouched();
	});

	it("preserves retries when SSO reconciliation fails", async () => {
		mocks.syncSsoSubscription.mockRejectedValue(
			new Error("Database unavailable"),
		);
		const response = await deliver(
			"customer.subscription.updated",
			subscription(),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expectProUntouched();
	});

	it("does not acknowledge a malformed SSO invoice as synchronized", async () => {
		const response = await deliver("invoice.paid", {
			id: "in_missing_subscription",
			subscription_details: { metadata: { type: "saml_sso" } },
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(mocks.syncSsoSubscription).not.toHaveBeenCalled();
		expectProUntouched();
	});
});
