import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	stripe: {
		checkout: { sessions: { retrieve: vi.fn(), update: vi.fn() } },
		customers: {
			listTaxIds: vi.fn(),
			createTaxId: vi.fn(),
			deleteTaxId: vi.fn(),
		},
	},
}));

vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ VERCEL_ENV: "development", WEB_URL: "https://cap.test" }),
}));
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined }),
	headers: async () => new Headers(),
}));
vi.mock("@cap/database/referrals", () => ({ DUB_CLICK_ID_COOKIE: "dub_id" }));
vi.mock("@/lib/checkout/customer", () => ({ ensureStripeCustomerId: vi.fn() }));
vi.mock("@/lib/checkout/enabled", () => ({
	customCheckoutEnabled: () => true,
}));
vi.mock("@/lib/checkout/stripe", () => ({
	checkoutStripe: () => mocks.stripe,
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: vi.fn(async () => false),
	RATE_LIMIT_IDS: {},
}));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));

import { setProCheckoutUsEin } from "@/actions/billing/checkout";
import { formatUsEin } from "@/lib/checkout/us-ein";

const clientSecret = "cs_test_1_secret_abc";

const session = (overrides: Record<string, unknown> = {}) => ({
	client_secret: clientSecret,
	status: "open",
	customer: null,
	metadata: { checkoutUi: "elements" },
	...overrides,
});

describe("formatUsEin", () => {
	it("accepts nine digits with or without the dash", () => {
		expect(formatUsEin("123456789")).toBe("12-3456789");
		expect(formatUsEin(" 12-3456789 ")).toBe("12-3456789");
	});

	it("rejects anything that is not nine digits", () => {
		expect(formatUsEin("12345")).toBeNull();
		expect(formatUsEin("1234567890")).toBeNull();
		expect(formatUsEin("12-345678a")).toBeNull();
	});
});

describe("setProCheckoutUsEin", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.stripe.customers.listTaxIds.mockResolvedValue({ data: [] });
	});

	it("stores the EIN on a guest session without touching a customer", async () => {
		mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(session());

		await expect(
			setProCheckoutUsEin({ clientSecret, ein: "123456789" }),
		).resolves.toEqual({ ok: true });
		expect(mocks.stripe.checkout.sessions.update).toHaveBeenCalledWith(
			"cs_test_1",
			{ metadata: { usEin: "12-3456789" } },
		);
		expect(mocks.stripe.customers.createTaxId).not.toHaveBeenCalled();
	});

	it("attaches the EIN to an existing customer so the first invoice carries it", async () => {
		mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(
			session({ customer: "cus_1" }),
		);

		await setProCheckoutUsEin({ clientSecret, ein: "12-3456789" });
		expect(mocks.stripe.customers.createTaxId).toHaveBeenCalledWith("cus_1", {
			type: "us_ein",
			value: "12-3456789",
		});
	});

	it("replaces an EIN this session set earlier and keeps unrelated ones", async () => {
		mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(
			session({
				customer: "cus_1",
				metadata: { checkoutUi: "elements", usEin: "11-1111111" },
			}),
		);
		mocks.stripe.customers.listTaxIds.mockResolvedValue({
			data: [
				{ id: "txi_old", type: "us_ein", value: "11-1111111" },
				{ id: "txi_other", type: "us_ein", value: "33-3333333" },
			],
		});

		await setProCheckoutUsEin({ clientSecret, ein: "" });
		expect(mocks.stripe.checkout.sessions.update).toHaveBeenCalledWith(
			"cs_test_1",
			{ metadata: { usEin: "" } },
		);
		expect(mocks.stripe.customers.deleteTaxId).toHaveBeenCalledTimes(1);
		expect(mocks.stripe.customers.deleteTaxId).toHaveBeenCalledWith(
			"cus_1",
			"txi_old",
		);
		expect(mocks.stripe.customers.createTaxId).not.toHaveBeenCalled();
	});

	it("rejects a wrong client secret, a closed session or a malformed EIN", async () => {
		mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(session());
		await expect(
			setProCheckoutUsEin({
				clientSecret: "cs_test_1_secret_wrong",
				ein: "123456789",
			}),
		).resolves.toEqual({ ok: false });

		mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(
			session({ status: "complete" }),
		);
		await expect(
			setProCheckoutUsEin({ clientSecret, ein: "123456789" }),
		).resolves.toEqual({ ok: false });

		await expect(
			setProCheckoutUsEin({ clientSecret, ein: "12345" }),
		).resolves.toEqual({ ok: false });

		expect(mocks.stripe.checkout.sessions.update).not.toHaveBeenCalled();
		expect(mocks.stripe.customers.createTaxId).not.toHaveBeenCalled();
	});
});
