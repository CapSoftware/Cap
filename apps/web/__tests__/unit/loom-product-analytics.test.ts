import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	queueDurableServerProductEvent: vi.fn(),
}));

vi.mock("@/lib/analytics/product-event-outbox", () => ({
	attemptProductAnalyticsOutboxDelivery: vi.fn(),
	persistProductAnalyticsEvent: vi.fn(),
	queueDurableServerProductEvent: mocks.queueDurableServerProductEvent,
}));

import { queueLoomAnalyticsEvent } from "@/workflows/import-loom-video";

describe("Loom product analytics delivery", () => {
	beforeEach(() => {
		mocks.queueDurableServerProductEvent.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces persistence failure so the durable workflow retries", async () => {
		mocks.queueDurableServerProductEvent.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(
			queueLoomAnalyticsEvent({
				eventId: "loom_import:video-1:completed",
				eventName: "loom_import_completed",
				occurredAt: "2026-08-01T12:00:00.000Z",
				platform: "server",
				userId: "user-1",
				organizationId: "org-1",
				properties: { import_mode: "direct", duration_ms: 1_000 },
			}),
		).rejects.toThrow("database unavailable");
	});

	it("commits completion and its outbox fact in one transaction", () => {
		const source = readFileSync(
			new URL("../../workflows/import-loom-video.ts", import.meta.url),
			"utf8",
		);
		const completionFunction = source.indexOf(
			"async function saveMetadataAndComplete",
		);
		const transaction = source.indexOf(
			"await db().transaction",
			completionFunction,
		);
		const eventPersistence = source.indexOf(
			"await persistProductAnalyticsEvent(tx, completedEvent)",
			transaction,
		);
		const completionDelivery = source.indexOf("await startLoomAnalyticsEvent");
		const businessCatch = source.indexOf("} catch (error)");

		expect(transaction).toBeGreaterThan(completionFunction);
		expect(eventPersistence).toBeGreaterThan(transaction);
		expect(completionDelivery).toBeGreaterThan(businessCatch);
	});
});
