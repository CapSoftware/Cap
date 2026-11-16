import { STRIPE_PLAN_IDS } from "@cap/utils";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as startGuestCheckout } from "@/app/api/settings/billing/guest-checkout/route";
import { POST as subscribe } from "@/app/api/settings/billing/subscribe/route";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	getCurrentUser: vi.fn(),
	env: {} as Record<string, string | undefined>,
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => mocks.env,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@cap/database", () => ({
	db: () => ({ update: () => ({ set: () => ({ where: vi.fn() }) }) }),
}));

vi.mock("@cap/database/schema", () => ({ users: { id: "id" } }));

vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return {
		...actual,
		stripe: () => ({
			customers: {
				list: vi.fn().mockResolvedValue({ data: [] }),
				create: vi.fn().mockResolvedValue({ id: "cus_new" }),
				update: vi.fn().mockResolvedValue({ id: "cus_new" }),
			},
			checkout: { sessions: { create: mocks.create } },
		}),
		userIsPro: vi.fn().mockReturnValue(false),
	};
});

vi.mock("@/lib/server-analytics", () => ({
	trackServerEvent: vi.fn(),
}));

vi.mock("@/lib/checkout/stripe", () => ({
	checkoutStripe: () => ({
		subscriptions: { list: vi.fn(async () => ({ data: [] })) },
	}),
}));

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const referredCustomer = [
	{
		externalId: "user_123",
		discount: {
			id: "disc_1",
			couponId: "cpn_partner20",
			couponTestId: "tst_cpn",
		},
	},
];

const dubRoutes = (customers: unknown = []) =>
	fetchMock.mockImplementation(async (input) => {
		const url = String(input);
		if (url.startsWith("https://api.dub.co/track/lead")) return json({});
		if (url.startsWith("https://api.dub.co/customers")) return json(customers);
		throw new Error(`unexpected fetch ${url}`);
	});

const request = (
	path: string,
	body: Record<string, unknown>,
	cookie?: string,
) =>
	new NextRequest(`https://cap.so${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});

const sessionParams = () =>
	mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;

const dubCalls = () => fetchMock.mock.calls.map(([input]) => String(input));

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	mocks.env = {
		WEB_URL: "https://cap.so",
		DUB_API_KEY: "dub_test_key",
		VERCEL_ENV: "production",
	};
	mocks.getCurrentUser.mockResolvedValue({
		id: "user_123",
		email: "user@example.com",
		name: "User",
		image: null,
		stripeCustomerId: "cus_123",
	});
	mocks.create.mockResolvedValue({
		id: "cs_test",
		url: "https://pay.cap.so/session",
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("signed-in checkout referral handling", () => {
	const priceId = STRIPE_PLAN_IDS.production.monthly;

	it("applies the partner discount a referred user is owed", async () => {
		dubRoutes(referredCustomer);

		const response = await subscribe(
			request("/api/settings/billing/subscribe", { priceId, quantity: 1 }),
		);

		expect(response.status).toBe(200);
		const params = sessionParams();
		expect(params.discounts).toEqual([{ coupon: "cpn_partner20" }]);
		expect(params).not.toHaveProperty("allow_promotion_codes");
		expect(params.metadata).toEqual({
			platform: "web",
			dubCustomerId: "user_123",
			isOnBoarding: "false",
			dubDiscountId: "disc_1",
		});
		expect(dubCalls()).toEqual([
			"https://api.dub.co/customers?externalId=user_123&includeExpandedFields=true",
		]);
	});

	it("keeps promotion codes for users who were not referred", async () => {
		dubRoutes([]);

		await subscribe(
			request("/api/settings/billing/subscribe", { priceId, quantity: 1 }),
		);

		const params = sessionParams();
		expect(params.allow_promotion_codes).toBe(true);
		expect(params).not.toHaveProperty("discounts");
		expect(params.metadata).not.toHaveProperty("dubDiscountId");
	});

	it("credits a partner click for a user Dub doesn't know yet", async () => {
		let leadRecorded = false;
		fetchMock.mockImplementation(async (input) => {
			const url = String(input);
			if (url.startsWith("https://api.dub.co/track/lead")) {
				leadRecorded = true;
				return json({});
			}
			return json(leadRecorded ? referredCustomer : []);
		});

		await subscribe(
			request(
				"/api/settings/billing/subscribe",
				{ priceId, quantity: 1 },
				"dub_id=click_1",
			),
		);

		expect(dubCalls()).toEqual([
			"https://api.dub.co/customers?externalId=user_123&includeExpandedFields=true",
			"https://api.dub.co/track/lead",
			"https://api.dub.co/customers?externalId=user_123&includeExpandedFields=true",
		]);
		const lead = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(lead).toMatchObject({
			clickId: "click_1",
			customerExternalId: "user_123",
			eventName: "Sign Up",
			mode: "wait",
		});
		expect(sessionParams().discounts).toEqual([{ coupon: "cpn_partner20" }]);
	});

	it("does not re-send a lead for a user who is already a referral", async () => {
		dubRoutes(referredCustomer);

		await subscribe(
			request(
				"/api/settings/billing/subscribe",
				{ priceId, quantity: 1 },
				"dub_id=click_other",
			),
		);

		expect(dubCalls()).toEqual([
			"https://api.dub.co/customers?externalId=user_123&includeExpandedFields=true",
		]);
		expect(sessionParams().discounts).toEqual([{ coupon: "cpn_partner20" }]);
	});

	it("opens a full-price checkout when Stripe rejects the partner coupon", async () => {
		dubRoutes(referredCustomer);
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.create.mockRejectedValueOnce(
			Object.assign(new Error("No such coupon: 'cpn_partner20'"), {
				type: "StripeInvalidRequestError",
				code: "resource_missing",
				param: "discounts[0][coupon]",
			}),
		);

		const response = await subscribe(
			request("/api/settings/billing/subscribe", { priceId, quantity: 1 }),
		);

		expect(response.status).toBe(200);
		expect(mocks.create).toHaveBeenCalledTimes(2);
		const retry = mocks.create.mock.calls[1]?.[0] as Record<string, unknown>;
		expect(retry).not.toHaveProperty("discounts");
		expect(retry.allow_promotion_codes).toBe(true);
		expect(retry.metadata).not.toHaveProperty("dubDiscountId");
	});

	it("does not retry when Stripe fails for another reason", async () => {
		dubRoutes(referredCustomer);
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.create.mockRejectedValueOnce(
			Object.assign(new Error("Invalid price"), {
				type: "StripeInvalidRequestError",
				param: "line_items[0][price]",
			}),
		);

		const response = await subscribe(
			request("/api/settings/billing/subscribe", { priceId, quantity: 1 }),
		);

		expect(response.status).toBe(500);
		expect(mocks.create).toHaveBeenCalledTimes(1);
	});

	it("still opens checkout when Dub is down", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await subscribe(
			request(
				"/api/settings/billing/subscribe",
				{ priceId, quantity: 1 },
				"dub_id=click_1",
			),
		);

		expect(response.status).toBe(200);
		expect(sessionParams().allow_promotion_codes).toBe(true);
	});

	it("skips Dub entirely on deployments without a Dub key", async () => {
		mocks.env.DUB_API_KEY = undefined;

		await subscribe(
			request(
				"/api/settings/billing/subscribe",
				{ priceId, quantity: 1 },
				"dub_id=click_1",
			),
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sessionParams().allow_promotion_codes).toBe(true);
	});
});

describe("guest checkout referral handling", () => {
	const priceId = STRIPE_PLAN_IDS.production.monthly;

	it("hands the partner click to Dub's Stripe integration", async () => {
		await startGuestCheckout(
			request(
				"/api/settings/billing/guest-checkout",
				{ priceId, quantity: 1 },
				"dub_id=click_1",
			),
		);

		const params = sessionParams();
		expect(params.client_reference_id).toBe("dub_id_click_1");
		expect(params.allow_promotion_codes).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not set a client reference without a valid click", async () => {
		await startGuestCheckout(
			request(
				"/api/settings/billing/guest-checkout",
				{ priceId, quantity: 1 },
				"dub_id=bad value",
			),
		);

		expect(sessionParams()).not.toHaveProperty("client_reference_id");
	});
});
