import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	queue: vi.fn(async () => ({
		eventId: "checkout:cs_1",
		payloadHash: "hash-1",
		payloadConflict: false,
		status: "started",
		runId: "run-1",
	})),
}));

vi.mock("@/lib/analytics/product-event-outbox", () => ({
	queueDurableServerProductEvent: mocks.queue,
}));

describe("analytics durable enqueue", () => {
	afterEach(() => {
		mocks.queue.mockClear();
	});

	it("returns only after the workflow run is durably enqueued", async () => {
		const { queueServerProductEvent } = await import("@/lib/analytics/server");
		await expect(
			queueServerProductEvent({
				eventId: "checkout:cs_1",
				eventName: "checkout_started",
				occurredAt: "2026-07-12T12:00:00.000Z",
				anonymousId: "anonymous-1",
				platform: "web",
				properties: { price_id: "price_1", quantity: 1 },
			}),
		).resolves.toEqual({
			eventId: "checkout:cs_1",
			payloadHash: "hash-1",
			payloadConflict: false,
			status: "started",
			runId: "run-1",
		});
		expect(mocks.queue).toHaveBeenCalledOnce();
	});

	it("surfaces enqueue failure so a critical business request can retry", async () => {
		mocks.queue.mockRejectedValueOnce(new Error("database unavailable"));
		const { queueServerProductEvent } = await import("@/lib/analytics/server");
		await expect(
			queueServerProductEvent({
				eventId: "signup:user-1",
				eventName: "user_signed_up",
				occurredAt: "2026-07-12T12:00:00.000Z",
				platform: "web",
				userId: "user-1",
			}),
		).rejects.toThrow("database unavailable");
	});
});
