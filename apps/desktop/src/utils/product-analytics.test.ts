import type { ProductEventInput } from "@cap/analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductAnalyticsQueue } from "./product-analytics";

function productEvent(index: number): ProductEventInput {
	return {
		eventId: `event-${index}`,
		eventName: "recording_started",
		occurredAt: "2026-07-12T12:00:00.000Z",
		anonymousId: "install-id",
		sessionId: "session-id",
		platform: "desktop",
		appVersion: "0.5.6",
		properties: { index },
	};
}

function sendBatchMock() {
	return vi.fn(async (_events: ProductEventInput[]) => {});
}

describe("ProductAnalyticsQueue", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("batches events after the short collection window", async () => {
		const sendBatch = sendBatchMock();
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => true,
			batchDelayMs: 25,
		});

		queue.enqueue(productEvent(1));
		queue.enqueue(productEvent(2));
		expect(sendBatch).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(25);

		expect(sendBatch).toHaveBeenCalledOnce();
		expect(sendBatch.mock.calls[0]?.[0].map((event) => event.eventId)).toEqual([
			"event-1",
			"event-2",
		]);
	});

	it("flushes immediately at the batch limit", async () => {
		const sendBatch = sendBatchMock();
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => true,
			batchSize: 3,
		});

		queue.enqueue(productEvent(1));
		queue.enqueue(productEvent(2));
		queue.enqueue(productEvent(3));
		await Promise.resolve();
		await Promise.resolve();

		expect(sendBatch).toHaveBeenCalledOnce();
		expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(3);
	});

	it("never sends more than the configured batch size", async () => {
		const sizes: number[] = [];
		const queue = new ProductAnalyticsQueue({
			sendBatch: async (events) => {
				sizes.push(events.length);
			},
			isEnabled: () => true,
			batchSize: 5,
			batchDelayMs: 10,
		});

		for (let index = 0; index < 13; index++) {
			queue.enqueue(productEvent(index));
		}
		await vi.runAllTimersAsync();

		expect(sizes.reduce((total, size) => total + size, 0)).toBe(13);
		expect(sizes.every((size) => size <= 5)).toBe(true);
	});

	it("keeps serialized requests under the byte limit", async () => {
		const requestSizes: number[] = [];
		const queue = new ProductAnalyticsQueue({
			sendBatch: async (events) => {
				requestSizes.push(
					new TextEncoder().encode(JSON.stringify({ events })).byteLength,
				);
			},
			isEnabled: () => true,
			batchDelayMs: 10,
			maxBatchBytes: 1500,
		});

		for (let index = 0; index < 10; index++) {
			queue.enqueue({
				...productEvent(index),
				properties: { value: "x".repeat(500) },
			});
		}
		await vi.runAllTimersAsync();

		expect(requestSizes).toHaveLength(5);
		expect(requestSizes.every((size) => size <= 1500)).toBe(true);
	});

	it("bounds memory and drops the oldest queued event", async () => {
		const sendBatch = sendBatchMock();
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => true,
			batchSize: 10,
			capacity: 3,
			batchDelayMs: 10,
		});

		for (let index = 0; index < 4; index++) {
			queue.enqueue(productEvent(index));
		}
		await vi.advanceTimersByTimeAsync(10);

		expect(queue.dropped).toBe(1);
		expect(sendBatch.mock.calls[0]?.[0].map((event) => event.eventId)).toEqual([
			"event-1",
			"event-2",
			"event-3",
		]);
	});

	it("does not send when telemetry is disabled", async () => {
		const sendBatch = sendBatchMock();
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => false,
			batchDelayMs: 10,
		});

		queue.enqueue(productEvent(1));
		await vi.advanceTimersByTimeAsync(10);

		expect(sendBatch).not.toHaveBeenCalled();
		expect(queue.size).toBe(0);
		expect(queue.dropped).toBe(1);
	});

	it("retries a failed event once and then drops it", async () => {
		const sendBatch = vi.fn(async (_events: ProductEventInput[]) => {
			throw new Error("offline");
		});
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => true,
			batchDelayMs: 10,
			retryDelayMs: 20,
		});

		queue.enqueue(productEvent(1));
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(20);

		expect(sendBatch).toHaveBeenCalledTimes(2);
		expect(queue.size).toBe(0);
		expect(queue.dropped).toBe(1);
	});

	it("does not retry an in-flight request after telemetry is disabled", async () => {
		let enabled = true;
		let failRequest: (() => void) | undefined;
		const sendBatch = vi.fn(
			(_events: ProductEventInput[]) =>
				new Promise<void>((_resolve, reject) => {
					failRequest = () => reject(new Error("aborted"));
				}),
		);
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => enabled,
			batchSize: 1,
			retryDelayMs: 10,
		});

		queue.enqueue(productEvent(1));
		await Promise.resolve();
		enabled = false;
		failRequest?.();
		await vi.runAllTimersAsync();

		expect(sendBatch).toHaveBeenCalledOnce();
		expect(queue.size).toBe(0);
		expect(queue.dropped).toBe(1);
	});

	it("keeps at most one request in flight", async () => {
		let completeFirst: (() => void) | undefined;
		let calls = 0;
		const sendBatch = vi.fn((_events: ProductEventInput[]) => {
			calls += 1;
			if (calls > 1) return Promise.resolve();
			return new Promise<void>((resolve) => {
				completeFirst = resolve;
			});
		});
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => true,
			batchSize: 1,
			batchDelayMs: 10,
		});

		queue.enqueue(productEvent(1));
		await Promise.resolve();
		queue.enqueue(productEvent(2));
		await queue.flush();

		expect(sendBatch).toHaveBeenCalledOnce();
		completeFirst?.();
		await vi.advanceTimersByTimeAsync(10);

		expect(sendBatch).toHaveBeenCalledTimes(2);
	});

	it("can synchronously clear queued events on opt-out", async () => {
		const sendBatch = sendBatchMock();
		const queue = new ProductAnalyticsQueue({
			sendBatch,
			isEnabled: () => true,
			batchDelayMs: 10,
		});

		queue.enqueue(productEvent(1));
		queue.enqueue(productEvent(2));
		queue.clear();
		await vi.runAllTimersAsync();

		expect(queue.size).toBe(0);
		expect(queue.dropped).toBe(2);
		expect(sendBatch).not.toHaveBeenCalled();
	});

	it("reports incremental drops while retaining the cumulative total", () => {
		const onDrop = vi.fn();
		const queue = new ProductAnalyticsQueue({
			sendBatch: sendBatchMock(),
			isEnabled: () => true,
			batchSize: 10,
			capacity: 2,
			onDrop,
		});

		queue.enqueue(productEvent(1));
		queue.enqueue(productEvent(2));
		queue.enqueue(productEvent(3));
		queue.clear();

		expect(onDrop.mock.calls).toEqual([[1], [2]]);
		expect(queue.dropped).toBe(3);
	});
});
