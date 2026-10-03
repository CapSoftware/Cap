import { isValidStripePlanPriceId, STRIPE_PLAN_IDS } from "@cap/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as subscribe } from "@/app/api/settings/billing/subscribe/route";

const checkoutMocks = vi.hoisted(() => ({
	create: vi.fn(),
	track: vi.fn(() => Promise.resolve()),
	getCurrentUser: vi.fn(),
	dbUpdate: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: checkoutMocks.getCurrentUser,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({
			set: () => ({
				where: checkoutMocks.dbUpdate,
			}),
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	users: { id: "id" },
}));

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
			checkout: {
				sessions: { create: checkoutMocks.create },
			},
		}),
		userIsPro: vi.fn().mockReturnValue(false),
	};
});

vi.mock("@/lib/server-analytics", () => ({
	trackServerEvent: checkoutMocks.track,
}));

const makeSubscribeRequest = (body: Record<string, unknown>) =>
	new Request("https://cap.so/api/settings/billing/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as import("next/server").NextRequest;

describe("Stripe plan allowlist", () => {
	it("accepts only legitimate Pro plan price IDs", () => {
		expect(isValidStripePlanPriceId(STRIPE_PLAN_IDS.development.yearly)).toBe(
			true,
		);
		expect(isValidStripePlanPriceId(STRIPE_PLAN_IDS.development.monthly)).toBe(
			true,
		);
		expect(isValidStripePlanPriceId(STRIPE_PLAN_IDS.production.yearly)).toBe(
			true,
		);
		expect(isValidStripePlanPriceId(STRIPE_PLAN_IDS.production.monthly)).toBe(
			true,
		);

		expect(isValidStripePlanPriceId("price_arbitrary_attacker_id")).toBe(false);
		expect(isValidStripePlanPriceId("price_free_tier")).toBe(false);
		expect(isValidStripePlanPriceId("")).toBe(false);
	});

	it("validates price IDs against specific deployment environments", () => {
		expect(
			isValidStripePlanPriceId(
				STRIPE_PLAN_IDS.development.yearly,
				"development",
			),
		).toBe(true);
		expect(
			isValidStripePlanPriceId(
				STRIPE_PLAN_IDS.production.yearly,
				"development",
			),
		).toBe(false);

		expect(
			isValidStripePlanPriceId(STRIPE_PLAN_IDS.production.yearly, "production"),
		).toBe(true);
		expect(
			isValidStripePlanPriceId(
				STRIPE_PLAN_IDS.development.yearly,
				"production",
			),
		).toBe(false);
	});
});

describe("POST /api/settings/billing/subscribe", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		checkoutMocks.getCurrentUser.mockResolvedValue({
			id: "user_123",
			email: "user@example.test",
			stripeCustomerId: "cus_123",
		});
		checkoutMocks.create.mockResolvedValue({
			id: "cs_test",
			url: "https://pay.cap.so/session",
		});
	});

	it("rejects arbitrary price IDs with 400", async () => {
		const response = await subscribe(
			makeSubscribeRequest({
				priceId: "price_arbitrary_malicious",
				quantity: 1,
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: true,
			message: "Invalid priceId",
		});
		expect(checkoutMocks.create).not.toHaveBeenCalled();
	});

	it("accepts valid Pro plan price ID and creates checkout session", async () => {
		const response = await subscribe(
			makeSubscribeRequest({
				priceId: STRIPE_PLAN_IDS.development.monthly,
				quantity: 2,
			}),
		);

		expect(response.status).toBe(200);
		expect(checkoutMocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_123",
				line_items: [
					{ price: STRIPE_PLAN_IDS.development.monthly, quantity: 2 },
				],
				mode: "subscription",
			}),
		);
	});
});
