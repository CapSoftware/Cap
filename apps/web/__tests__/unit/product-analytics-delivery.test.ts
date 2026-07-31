import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	identityRows: [[{ id: "user-1" }], [{ id: "org-1" }]] as unknown[][],
	identitySelectIndex: 0,
	sendProductAnalyticsRows: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: (selection: Record<string, unknown>) => {
			if ("userId" in selection) {
				return { from: () => ({ where: () => ({}) }) };
			}
			return {
				from: () => ({
					where: () => ({
						limit: async () =>
							mocks.identityRows[mocks.identitySelectIndex++] ?? [],
					}),
				}),
			};
		},
	}),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	and: (...conditions: unknown[]) => conditions,
	eq: () => true,
	isNull: () => true,
	notInArray: () => true,
}));

vi.mock("@cap/analytics", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/analytics")>()),
	sendProductAnalyticsRows: mocks.sendProductAnalyticsRows,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://staging.tinybird.test",
		PRODUCT_ANALYTICS_TINYBIRD_TOKEN: "ingest-token",
	}),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("workflow/api", () => ({
	start: vi.fn(),
}));

import { deliverProductAnalyticsEventStep } from "@/workflows/deliver-product-analytics-event";

const event = {
	eventId: "signup:user-1",
	eventName: "user_signed_up",
	platform: "web",
	userId: "user-1",
	organizationId: "org-1",
} as const;

describe("durable product analytics delivery", () => {
	beforeEach(() => {
		mocks.identityRows = [[{ id: "user-1" }], [{ id: "org-1" }]];
		mocks.identitySelectIndex = 0;
		mocks.sendProductAnalyticsRows.mockReset().mockResolvedValue(undefined);
	});

	it("suppresses a user that is missing or pending account deletion", async () => {
		mocks.identityRows = [[], [{ id: "org-1" }]];

		await expect(deliverProductAnalyticsEventStep(event)).resolves.toEqual({
			eventId: event.eventId,
			suppressed: true,
		});
		expect(mocks.sendProductAnalyticsRows).not.toHaveBeenCalled();
	});

	it("suppresses an organization after its tombstone is written", async () => {
		mocks.identityRows = [[{ id: "user-1" }], []];

		await expect(deliverProductAnalyticsEventStep(event)).resolves.toEqual({
			eventId: event.eventId,
			suppressed: true,
		});
		expect(mocks.sendProductAnalyticsRows).not.toHaveBeenCalled();
	});

	it("delivers once when both durable identities remain active", async () => {
		await expect(deliverProductAnalyticsEventStep(event)).resolves.toEqual({
			eventId: event.eventId,
		});
		expect(mocks.sendProductAnalyticsRows).toHaveBeenCalledTimes(1);
		expect(mocks.sendProductAnalyticsRows).toHaveBeenCalledWith(
			expect.objectContaining({ maxAttempts: 1, wait: true }),
		);
	});
});
