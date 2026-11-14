import {
	hasSsoAccess,
	isProSubscription,
	isSsoPrice,
	isSsoSubscription,
	isStandaloneScimSubscription,
	STRIPE_SAML_SSO_LEGACY_PRICE_ID,
	STRIPE_SAML_SSO_PRICE_ID,
	STRIPE_SAML_SSO_PRODUCT_ID,
	STRIPE_SCIM_PRICE_ID,
	STRIPE_SIGNED_BAA_PRICE_IDS,
} from "@cap/utils";
import { describe, expect, it, vi } from "vitest";

describe("Stripe subscription classification", () => {
	it("keeps standalone SCIM subscriptions out of Pro", () => {
		const scimOnly = {
			items: { data: [{ price: { id: STRIPE_SCIM_PRICE_ID } }] },
		};
		const taggedScim = {
			metadata: { type: "scim" },
			items: { data: [{ price: { id: "price_test_scim" } }] },
		};
		expect(isStandaloneScimSubscription(scimOnly)).toBe(true);
		expect(isProSubscription(scimOnly)).toBe(false);
		expect(isStandaloneScimSubscription(taggedScim)).toBe(true);
		expect(isProSubscription(taggedScim)).toBe(false);
	});

	it("recognizes a configured test-mode SCIM price as standalone SCIM", () => {
		const testScim = {
			items: { data: [{ price: { id: "price_test_scim" } }] },
		};
		expect(isProSubscription(testScim)).toBe(true);
		vi.stubEnv("STRIPE_SCIM_PRICE_ID", "price_test_scim");
		try {
			expect(isStandaloneScimSubscription(testScim)).toBe(true);
			expect(isProSubscription(testScim)).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps Pro and BAA subscriptions with a SCIM line classified as before", () => {
		const proWithScim = {
			items: {
				data: [
					{ price: { id: "price_pro" } },
					{ price: { id: STRIPE_SCIM_PRICE_ID } },
				],
			},
		};
		const baaWithScim = {
			metadata: { type: "signed_baa" },
			items: {
				data: [
					{ price: { id: STRIPE_SIGNED_BAA_PRICE_IDS.production } },
					{ price: { id: STRIPE_SCIM_PRICE_ID } },
				],
			},
		};
		expect(isStandaloneScimSubscription(proWithScim)).toBe(false);
		expect(isProSubscription(proWithScim)).toBe(true);
		expect(isStandaloneScimSubscription(baaWithScim)).toBe(false);
		expect(isProSubscription(baaWithScim)).toBe(false);
		expect(isProSubscription({ items: { data: [] } })).toBe(true);
	});

	it.each([STRIPE_SAML_SSO_PRICE_ID, STRIPE_SAML_SSO_LEGACY_PRICE_ID])(
		"recognizes paid SSO price %s without metadata",
		(priceId) => {
			const subscription = { items: { data: [{ price: { id: priceId } }] } };
			expect(isSsoPrice(priceId)).toBe(true);
			expect(isSsoSubscription(subscription)).toBe(true);
			expect(isProSubscription(subscription)).toBe(false);
		},
	);

	it.each([STRIPE_SAML_SSO_PRODUCT_ID, { id: STRIPE_SAML_SSO_PRODUCT_ID }])(
		"isolates SSO product subscriptions with an unrecognized price",
		(product) => {
			const subscription = {
				items: { data: [{ price: { id: "price_other_sso", product } }] },
			};
			expect(isSsoSubscription(subscription)).toBe(true);
			expect(isSsoPrice("price_other_sso")).toBe(false);
			expect(isProSubscription(subscription)).toBe(false);
		},
	);

	it("routes metadata-only SSO away from Pro without recognizing its price", () => {
		const subscription = {
			metadata: { type: "saml_sso" },
			items: { data: [{ price: { id: "price_unknown" } }] },
		};
		expect(isSsoSubscription(subscription)).toBe(true);
		expect(isSsoPrice("price_unknown")).toBe(false);
		expect(isProSubscription(subscription)).toBe(false);
	});

	it("excludes both price-only and metadata-only BAA subscriptions", () => {
		expect(isProSubscription({ metadata: { type: "signed_baa" } })).toBe(false);
		for (const priceId of Object.values(STRIPE_SIGNED_BAA_PRICE_IDS)) {
			expect(
				isProSubscription({ items: { data: [{ price: { id: priceId } }] } }),
			).toBe(false);
		}
	});

	it("preserves historical Pro prices", () => {
		const subscription = {
			items: { data: [{ price: { id: "price_legacy_pro" } }] },
		};
		expect(isSsoSubscription(subscription)).toBe(false);
		expect(isProSubscription(subscription)).toBe(true);
		expect(isSsoPrice(undefined)).toBe(false);
	});
});

describe("paid-through SSO entitlement", () => {
	const paidThrough = new Date("2026-09-01T00:00:00Z");

	it("keeps active access only during the confirmed paid period", () => {
		expect(
			hasSsoAccess(
				{ status: "active", paidThrough },
				new Date("2026-08-31T23:59:59Z"),
			),
		).toBe(true);
		expect(hasSsoAccess({ status: "active", paidThrough }, paidThrough)).toBe(
			false,
		);
	});

	it("grants a bounded seven-day grace only after a paid period", () => {
		expect(
			hasSsoAccess(
				{ status: "past_due", paidThrough },
				new Date("2026-09-07T23:59:59Z"),
			),
		).toBe(true);
		expect(
			hasSsoAccess(
				{ status: "past_due", paidThrough },
				new Date("2026-09-08T00:00:00Z"),
			),
		).toBe(false);
		expect(hasSsoAccess({ status: "past_due", paidThrough: null })).toBe(false);
	});

	it.each([
		"trialing",
		"canceled",
		"unpaid",
		"incomplete",
		"incomplete_expired",
	])("denies %s even with a future paid-through date", (status) => {
		expect(
			hasSsoAccess({ status, paidThrough }, new Date("2026-08-31T00:00:00Z")),
		).toBe(false);
	});

	it("fails closed for missing or invalid paid-through data", () => {
		expect(hasSsoAccess(null)).toBe(false);
		expect(hasSsoAccess({ status: "active", paidThrough: null })).toBe(false);
		expect(
			hasSsoAccess({ status: "active", paidThrough: new Date("invalid") }),
		).toBe(false);
	});
});
