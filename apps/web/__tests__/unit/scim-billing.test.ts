import { beforeEach, describe, expect, it, vi } from "vitest";

const SCIM_PRICE = "price_1UYt30FJxA1XpeSs0obc6kT0";

const mocks = vi.hoisted(() => ({
	record: [] as {
		ownerCustomerId: string | null;
		ssoCustomerId: string | null;
	}[],
	subscriptions: new Map<string, unknown[]>(),
	listed: [] as string[],
	stripeAvailable: true,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					leftJoin: () => ({
						where: () => ({ limit: async () => mocks.record }),
					}),
				}),
			}),
		}),
	}),
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	STRIPE_AVAILABLE: () => mocks.stripeAvailable,
	stripe: () => ({
		subscriptions: {
			list: ({ customer }: { customer: string }) => {
				mocks.listed.push(customer);
				return (async function* () {
					yield* mocks.subscriptions.get(customer) ?? [];
				})();
			},
		},
	}),
}));

const { hasScimSubscription } = await import("@/lib/sso/scim-billing");

function subscription(
	overrides: {
		status?: string;
		organizationId?: string;
		prices?: string[];
	} = {},
) {
	return {
		status: overrides.status ?? "active",
		metadata: { organizationId: overrides.organizationId ?? "org_cap" },
		items: {
			data: (overrides.prices ?? ["price_baa", SCIM_PRICE]).map((id) => ({
				price: { id },
			})),
		},
	};
}

const organizationId = "org_cap" as Parameters<typeof hasScimSubscription>[0];

describe("hasScimSubscription", () => {
	beforeEach(() => {
		mocks.record = [{ ownerCustomerId: "cus_owner", ssoCustomerId: null }];
		mocks.subscriptions = new Map();
		mocks.listed = [];
		mocks.stripeAvailable = true;
		vi.unstubAllEnvs();
	});

	it("accepts an active or past-due SCIM item tagged with the organization", async () => {
		mocks.subscriptions.set("cus_owner", [subscription()]);
		expect(await hasScimSubscription(organizationId)).toBe(true);
		mocks.subscriptions.set("cus_owner", [
			subscription({ status: "past_due" }),
		]);
		expect(await hasScimSubscription(organizationId)).toBe(true);
	});

	it("finds the SCIM item on the SSO billing customer too", async () => {
		mocks.record = [{ ownerCustomerId: "cus_owner", ssoCustomerId: "cus_sso" }];
		mocks.subscriptions.set("cus_sso", [subscription()]);
		expect(await hasScimSubscription(organizationId)).toBe(true);
		expect(mocks.listed).toEqual(["cus_owner", "cus_sso"]);
	});

	it("rejects other organizations, other prices, and lapsed subscriptions", async () => {
		for (const candidate of [
			subscription({ organizationId: "org_other" }),
			subscription({ prices: ["price_baa"] }),
			subscription({ status: "unpaid" }),
			subscription({ status: "incomplete" }),
			subscription({ status: "canceled" }),
		]) {
			mocks.subscriptions.set("cus_owner", [candidate]);
			expect(await hasScimSubscription(organizationId)).toBe(false);
		}
	});

	it("does not accept SCIM on the SAML SSO subscription", async () => {
		mocks.subscriptions.set("cus_owner", [
			{
				...subscription(),
				metadata: { organizationId: "org_cap", type: "saml_sso" },
			},
		]);
		expect(await hasScimSubscription(organizationId)).toBe(false);
	});

	it("accepts a configured test-mode SCIM price", async () => {
		mocks.subscriptions.set("cus_owner", [
			subscription({ prices: ["price_test_scim"] }),
		]);
		expect(await hasScimSubscription(organizationId)).toBe(false);
		vi.stubEnv("STRIPE_SCIM_PRICE_ID", "price_test_scim");
		expect(await hasScimSubscription(organizationId)).toBe(true);
	});

	it("is unavailable without Stripe or a billing customer", async () => {
		mocks.stripeAvailable = false;
		mocks.subscriptions.set("cus_owner", [subscription()]);
		expect(await hasScimSubscription(organizationId)).toBe(false);
		mocks.stripeAvailable = true;
		mocks.record = [{ ownerCustomerId: null, ssoCustomerId: null }];
		expect(await hasScimSubscription(organizationId)).toBe(false);
		expect(mocks.listed).toEqual([]);
	});
});
