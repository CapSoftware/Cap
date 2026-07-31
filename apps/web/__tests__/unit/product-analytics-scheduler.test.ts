import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	start: vi.fn(async () => ({ runId: "run-1" })),
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));

describe("analytics durable enqueue", () => {
	afterEach(() => {
		mocks.start.mockClear();
	});

	it("returns only after the workflow run is durably enqueued", async () => {
		const { queueServerProductEvent } = await import("@/lib/analytics/server");
		await expect(
			queueServerProductEvent({
				eventId: "checkout:cs_1",
				eventName: "checkout_started",
				anonymousId: "anonymous-1",
				platform: "web",
				properties: { price_id: "price_1", quantity: 1 },
			}),
		).resolves.toEqual({ eventId: "checkout:cs_1", runId: "run-1" });
		expect(mocks.start).toHaveBeenCalledOnce();
	});

	it("surfaces enqueue failure so a critical business request can retry", async () => {
		mocks.start.mockRejectedValueOnce(new Error("queue unavailable"));
		const { queueServerProductEvent } = await import("@/lib/analytics/server");
		await expect(
			queueServerProductEvent({
				eventId: "signup:user-1",
				eventName: "user_signed_up",
				platform: "server",
				userId: "user-1",
			}),
		).rejects.toThrow("queue unavailable");
	});
});
