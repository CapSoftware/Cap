import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	row: { organizationId: "org-1" } as { organizationId: string } | undefined,
	cookieValue: "anonymous-1" as string | undefined,
	persist: vi.fn(),
	queue: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (mocks.row ? [mocks.row] : []),
				}),
			}),
		}),
		transaction: mocks.transaction,
	}),
}));

vi.mock("@cap/database/schema", () => ({
	users: { activeOrganizationId: "activeOrganizationId", id: "id" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => "condition") }));

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: () =>
			mocks.cookieValue === undefined
				? undefined
				: { value: mocks.cookieValue },
	}),
}));

vi.mock("@/lib/analytics/product-event-outbox", () => ({
	persistProductAnalyticsEvent: mocks.persist,
	queueDurableServerProductEvent: mocks.queue,
}));

describe("recordWebAuthenticationSuccess", () => {
	beforeEach(() => {
		mocks.row = { organizationId: "org-1" };
		mocks.cookieValue = "anonymous-1";
		mocks.persist.mockReset().mockResolvedValue({ status: "pending" });
		mocks.queue.mockReset().mockResolvedValue({ status: "delivered" });
		mocks.transaction
			.mockReset()
			.mockImplementation(async (callback) => callback({ transaction: true }));
	});

	it("durably records sign-in and anonymous identity stitching", async () => {
		const { recordWebAuthenticationSuccess } = await import(
			"@/lib/analytics/authentication-events"
		);

		await recordWebAuthenticationSuccess("user-1");

		expect(mocks.persist).toHaveBeenCalledTimes(2);
		expect(mocks.queue).toHaveBeenCalledTimes(2);
		expect(mocks.persist.mock.calls.map((call) => call[1])).toEqual([
			expect.objectContaining({
				eventName: "user_signed_in",
				platform: "web",
				userId: "user-1",
				organizationId: "org-1",
				anonymousId: "anonymous-1",
			}),
			expect.objectContaining({
				eventName: "identity_linked",
				anonymousId: "anonymous-1",
			}),
		]);
	});

	it("records authenticated sign-in without inventing an anonymous link", async () => {
		mocks.cookieValue = undefined;
		const { recordWebAuthenticationSuccess } = await import(
			"@/lib/analytics/authentication-events"
		);

		await recordWebAuthenticationSuccess("user-1");

		expect(mocks.persist).toHaveBeenCalledOnce();
		expect(mocks.queue).toHaveBeenCalledOnce();
		expect(mocks.persist.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({ eventName: "user_signed_in" }),
		);
	});

	it("fails closed before delivery when the durable write fails", async () => {
		mocks.persist.mockRejectedValueOnce(new Error("database unavailable"));
		const { recordWebAuthenticationSuccess } = await import(
			"@/lib/analytics/authentication-events"
		);

		await expect(recordWebAuthenticationSuccess("user-1")).rejects.toThrow(
			"database unavailable",
		);
		expect(mocks.queue).not.toHaveBeenCalled();
	});
});
