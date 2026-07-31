import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	product: vi.fn(),
	readAnonymousId: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));
vi.mock("@cap/utils", () => ({
	stripe: () => ({
		checkout: { sessions: { create: mocks.createSession } },
	}),
}));
vi.mock("@/lib/analytics/server", () => ({
	readAnalyticsAnonymousId: mocks.readAnonymousId,
	queueServerProductEvent: mocks.product,
}));

describe("guest checkout analytics", () => {
	let POST: typeof import("@/app/api/settings/billing/guest-checkout/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.product.mockResolvedValue(undefined);
		mocks.createSession.mockResolvedValue({
			id: "cs_guest_1",
			created: 1_754_000_000,
			url: "https://checkout.stripe.com/session",
		});
		POST = (await import("@/app/api/settings/billing/guest-checkout/route"))
			.POST;
	});

	it("uses one stable fallback identity through checkout and purchase metadata", async () => {
		mocks.readAnonymousId.mockReturnValue(undefined);
		const response = await POST(
			new NextRequest("https://cap.so/api/settings/billing/guest-checkout", {
				method: "POST",
				body: JSON.stringify({ priceId: "price_team", quantity: 3 }),
			}),
		);
		expect(response.status).toBe(200);

		const metadata = mocks.createSession.mock.calls[0]?.[0].metadata;
		expect(metadata.analyticsAnonymousId).toMatch(/^guest:/);
		expect(metadata.analyticsIsFirstPurchase).toBe("true");
		expect(mocks.product).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "checkout:cs_guest_1",
				anonymousId: metadata.analyticsAnonymousId,
			}),
		);
	});

	it("preserves an existing browser identity", async () => {
		mocks.readAnonymousId.mockReturnValue("anonymous-browser-1");
		await POST(
			new NextRequest("https://cap.so/api/settings/billing/guest-checkout", {
				method: "POST",
				body: JSON.stringify({ priceId: "price_team", quantity: 1 }),
			}),
		);
		expect(
			mocks.createSession.mock.calls[0]?.[0].metadata.analyticsAnonymousId,
		).toBe("anonymous-browser-1");
	});
});
