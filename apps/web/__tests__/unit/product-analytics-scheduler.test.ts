import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	after: vi.fn(() => {
		throw new Error("after unavailable");
	}),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		PRODUCT_ANALYTICS_TINYBIRD_HOST: undefined,
		PRODUCT_ANALYTICS_TINYBIRD_TOKEN: undefined,
	}),
}));

describe("analytics scheduling", () => {
	afterEach(() => vi.restoreAllMocks());

	it("cannot make a business route fail when after is unavailable", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { scheduleServerProductEvent } = await import(
			"@/lib/analytics/server"
		);

		expect(() =>
			scheduleServerProductEvent({
				eventId: "checkout:cs_1",
				eventName: "checkout_started",
				anonymousId: "anonymous-1",
				platform: "web",
			}),
		).not.toThrow();
		await Promise.resolve();
		expect(mocks.after).toHaveBeenCalledOnce();
	});
});
