import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkout: {
		checkout: { sessions: { retrieve: vi.fn(), update: vi.fn() } },
	},
	stripe: {
		subscriptions: { retrieve: vi.fn(), deleteDiscount: vi.fn() },
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
vi.mock("@cap/database/referrals", () => ({
	DUB_CLICK_ID_COOKIE: "dub_id",
	findReferralCustomer: vi.fn(),
	getReferralDiscount: vi.fn(),
	parseDubClickId: () => null,
	trackReferralLead: vi.fn(),
}));
vi.mock("@/lib/checkout/customer", () => ({ ensureStripeCustomerId: vi.fn() }));
vi.mock("@/lib/checkout/enabled", () => ({
	customCheckoutEnabled: () => true,
}));
vi.mock("@/lib/checkout/stripe", () => ({
	checkoutStripe: () => mocks.checkout,
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: vi.fn(async () => false),
	RATE_LIMIT_IDS: { GUEST_CHECKOUT: "guest-checkout", CHECKOUT: "checkout" },
}));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return { ...actual, stripe: () => mocks.stripe };
});

import { changeProCheckoutPlan } from "@/actions/billing/checkout";
import { dropCapFridayFromMonthly } from "@/lib/checkout/cap-friday";

const YEARLY = "price_1Q3esrFJxA1XpeSsFwp486RN";
const MONTHLY = "price_1P9C1DFJxA1XpeSsTwwuddnq";
const SECRET = "cs_test_1_secret_abc";

const session = (code: string | null) => ({
	id: "cs_test_1",
	client_secret: SECRET,
	status: "open",
	metadata: { checkoutUi: "elements" },
	line_items: { data: [{ id: "li_1", quantity: 2, price: { id: YEARLY } }] },
	discounts: code ? [{ promotion_code: { id: "promo_1", code } }] : [],
});

const subscription = (price: string, code: string | null) => ({
	id: "sub_1",
	items: { data: [{ price: { id: price } }] },
	discount: code ? { promotion_code: { id: "promo_1", code } } : null,
});

describe("Cap Friday stays on yearly on the server", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkout.checkout.sessions.update.mockResolvedValue({});
		mocks.stripe.subscriptions.deleteDiscount.mockResolvedValue({});
	});

	it("refuses to move a BLACKFRIDAY checkout to monthly", async () => {
		mocks.checkout.checkout.sessions.retrieve.mockResolvedValue(
			session("BLACKFRIDAY"),
		);

		expect(
			await changeProCheckoutPlan({ clientSecret: SECRET, plan: "monthly" }),
		).toEqual({ ok: false });
		expect(mocks.checkout.checkout.sessions.retrieve).toHaveBeenCalledWith(
			"cs_test_1",
			{ expand: ["line_items", "discounts.promotion_code"] },
		);
		expect(mocks.checkout.checkout.sessions.update).not.toHaveBeenCalled();
	});

	it("keeps a BLACKFRIDAY checkout able to stay yearly", async () => {
		mocks.checkout.checkout.sessions.retrieve.mockResolvedValue(
			session("BLACKFRIDAY"),
		);

		expect(
			await changeProCheckoutPlan({ clientSecret: SECRET, plan: "yearly" }),
		).toEqual({ ok: true });
	});

	it("moves checkouts with other codes to monthly", async () => {
		mocks.checkout.checkout.sessions.retrieve.mockResolvedValue(
			session("MIGRATE20"),
		);

		expect(
			await changeProCheckoutPlan({ clientSecret: SECRET, plan: "monthly" }),
		).toEqual({ ok: true });
		expect(mocks.checkout.checkout.sessions.update).toHaveBeenCalledWith(
			"cs_test_1",
			{ line_items: [{ id: "li_1", price: MONTHLY, quantity: 2 }] },
		);
	});

	it("removes BLACKFRIDAY from a new monthly subscription", async () => {
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			subscription(MONTHLY, "BLACKFRIDAY"),
		);

		expect(await dropCapFridayFromMonthly("sub_1")).toBe(true);
		expect(mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1", {
			expand: ["discount.promotion_code"],
		});
		expect(mocks.stripe.subscriptions.deleteDiscount).toHaveBeenCalledWith(
			"sub_1",
		);
	});

	it.each([
		["a yearly BLACKFRIDAY subscription", YEARLY, "BLACKFRIDAY"],
		["a monthly subscription with another code", MONTHLY, "MIGRATE20"],
		["a monthly subscription without a code", MONTHLY, null],
	])("leaves %s alone", async (_, price, code) => {
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			subscription(price, code),
		);

		expect(await dropCapFridayFromMonthly("sub_1")).toBe(false);
		expect(mocks.stripe.subscriptions.deleteDiscount).not.toHaveBeenCalled();
	});
});
