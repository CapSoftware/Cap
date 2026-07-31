import {
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventInput,
} from "@cap/analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createProductEventId,
	getOrCreateBrowserAnonymousId,
	getOrCreateStorageId,
	ProductAnalyticsQueue,
	type ProductAnalyticsTransport,
	sendBrowserProductAnalytics,
	shouldCaptureProductPageView,
} from "@/app/utils/product-analytics";

const makeEvent = (index: number): ProductEventInput => ({
	eventId: `event-${index}`,
	eventName: "page_view",
	occurredAt: "2026-07-12T12:00:00.000Z",
	anonymousId: "anonymous-1",
	sessionId: "session-1",
	platform: "web",
});

describe("ProductAnalyticsQueue", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not perform network work on enqueue", () => {
		const transport = vi.fn<ProductAnalyticsTransport>();
		const queue = new ProductAnalyticsQueue(transport);
		queue.enqueue(makeEvent(1));
		expect(transport).not.toHaveBeenCalled();
	});

	it("flushes one batch after the interval", async () => {
		const transport = vi
			.fn<ProductAnalyticsTransport>()
			.mockResolvedValue("success");
		const queue = new ProductAnalyticsQueue(transport);
		queue.enqueue(makeEvent(1));
		queue.enqueue(makeEvent(2));

		await vi.advanceTimersByTimeAsync(5_000);
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[0]).toHaveLength(2);
		expect(transport.mock.calls[0]?.[2]).toMatchObject({
			attempted: 2,
			accepted: 2,
		});
	});

	it("counts contract rejections as observable drops", () => {
		const queue = new ProductAnalyticsQueue(vi.fn<ProductAnalyticsTransport>());
		queue.recordContractRejection();
		expect(queue.deliverySnapshot).toMatchObject({
			dropped: 1,
			contract_rejected: 1,
		});
	});

	it("flushes immediately when a full batch is queued", async () => {
		const transport = vi
			.fn<ProductAnalyticsTransport>()
			.mockResolvedValue("success");
		const queue = new ProductAnalyticsQueue(transport);
		for (let i = 0; i < PRODUCT_ANALYTICS_LIMITS.batchSize; i += 1) {
			queue.enqueue(makeEvent(i));
		}
		await queue.flush();
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[0]).toHaveLength(
			PRODUCT_ANALYTICS_LIMITS.batchSize,
		);
	});

	it("allows only one request in flight", async () => {
		let resolveTransport: ((value: "success") => void) | undefined;
		const transport = vi.fn<ProductAnalyticsTransport>().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveTransport = resolve;
				}),
		);
		const queue = new ProductAnalyticsQueue(transport);
		queue.enqueue(makeEvent(1));
		const first = queue.flush();
		const second = queue.flush();
		expect(first).toBe(second);
		expect(transport).toHaveBeenCalledTimes(1);
		resolveTransport?.("success");
		await first;
	});

	it("retries a failed batch once", async () => {
		const transport = vi
			.fn<ProductAnalyticsTransport>()
			.mockResolvedValueOnce("retry")
			.mockResolvedValueOnce("retry");
		const queue = new ProductAnalyticsQueue(transport);
		queue.enqueue(makeEvent(1));
		await queue.flush();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(transport).toHaveBeenCalledTimes(2);
		expect(queue.size).toBe(0);
	});

	it("honors retry backoff for a full failed batch", async () => {
		const transport = vi
			.fn<ProductAnalyticsTransport>()
			.mockResolvedValueOnce("retry")
			.mockResolvedValueOnce("success");
		const queue = new ProductAnalyticsQueue(transport);
		for (let i = 0; i < PRODUCT_ANALYTICS_LIMITS.batchSize; i += 1) {
			queue.enqueue(makeEvent(i));
		}
		await Promise.resolve();
		await Promise.resolve();

		expect(transport).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1_999);
		expect(transport).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(transport).toHaveBeenCalledTimes(2);
	});

	it("does not retry a rejected batch", async () => {
		const transport = vi
			.fn<ProductAnalyticsTransport>()
			.mockResolvedValue("drop");
		const queue = new ProductAnalyticsQueue(transport);
		queue.enqueue(makeEvent(1));
		await queue.flush();
		await vi.runAllTimersAsync();
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("bounds memory and drops the oldest queued events", async () => {
		let resolveFirst: ((value: "success") => void) | undefined;
		const transport = vi
			.fn<ProductAnalyticsTransport>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValue("success");
		const queue = new ProductAnalyticsQueue(transport);
		for (let i = 0; i < PRODUCT_ANALYTICS_LIMITS.queueSize + 30; i += 1) {
			queue.enqueue(makeEvent(i));
		}
		expect(queue.size).toBe(PRODUCT_ANALYTICS_LIMITS.queueSize);
		expect(transport.mock.calls[0]?.[0][0]?.eventId).toBe("event-0");
		resolveFirst?.("success");
		await vi.waitFor(() =>
			expect(transport.mock.calls.length).toBeGreaterThanOrEqual(2),
		);
		expect(transport.mock.calls[1]?.[0][0]?.eventId).toBe("event-30");
	});

	it("keeps every request under the body size limit", async () => {
		const requestSizes: number[] = [];
		const transport = vi.fn<ProductAnalyticsTransport>(async (events) => {
			requestSizes.push(
				new TextEncoder().encode(JSON.stringify({ events })).byteLength,
			);
			return "success";
		});
		const queue = new ProductAnalyticsQueue(transport);
		for (let i = 0; i < 10; i += 1) {
			queue.enqueue({
				...makeEvent(i),
				properties: { value: "x".repeat(20_000) },
			});
		}

		await vi.runAllTimersAsync();
		expect(
			requestSizes.every(
				(size) => size <= PRODUCT_ANALYTICS_LIMITS.requestBytes,
			),
		).toBe(true);
		expect(
			transport.mock.calls.reduce(
				(count, [events]) => count + events.length,
				0,
			),
		).toBe(10);
	});

	it("drops a single event larger than the request limit", async () => {
		const transport = vi.fn<ProductAnalyticsTransport>();
		const queue = new ProductAnalyticsQueue(transport);
		queue.enqueue({
			...makeEvent(1),
			properties: {
				value: "x".repeat(PRODUCT_ANALYTICS_LIMITS.requestBytes),
			},
		});

		await vi.runAllTimersAsync();
		expect(transport).not.toHaveBeenCalled();
		expect(queue.size).toBe(0);
	});
});

describe("browser analytics identity", () => {
	it("falls back when secure UUID generation is unavailable", () => {
		const randomValues = (values: Uint32Array) => {
			values.set([123, 456]);
			return values;
		};
		expect(createProductEventId(null, 1_000, randomValues)).toBe(
			"fallback-rs-3f-co",
		);
		expect(
			createProductEventId(
				() => {
					throw new Error("blocked");
				},
				1_000,
				randomValues,
			),
		).toBe("fallback-rs-3f-co");
		expect(createProductEventId(null, 1_000, null)).toMatch(
			/^fallback-rs-counter-[a-z0-9]+$/,
		);
	});

	it("reuses a persisted identifier", () => {
		const storage = {
			getItem: vi.fn(() => "existing-id"),
			setItem: vi.fn(),
		};
		expect(getOrCreateStorageId(storage, "key", () => "new-id")).toBe(
			"existing-id",
		);
		expect(storage.setItem).not.toHaveBeenCalled();
	});

	it("creates and persists an identifier once", () => {
		const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
		expect(getOrCreateStorageId(storage, "key", () => "new-id")).toBe("new-id");
		expect(storage.setItem).toHaveBeenCalledWith("key", "new-id");
	});

	it("uses the server-issued cookie identity", () => {
		const storage = { getItem: vi.fn(() => "stale-id"), setItem: vi.fn() };
		expect(
			getOrCreateBrowserAnonymousId(storage, "signed-id", () => "new-id"),
		).toBe("signed-id");
		expect(storage.setItem).toHaveBeenCalledWith(
			"cap_analytics_anonymous_id_v1",
			"signed-id",
		);
	});

	it("regenerates a cookie identity containing personal data", () => {
		const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
		expect(
			getOrCreateBrowserAnonymousId(
				storage,
				"alice@example.com",
				() => "safe-id",
			),
		).toBe("safe-id");
	});

	it("falls back when storage is unavailable", () => {
		const storage = {
			getItem: vi.fn(() => {
				throw new Error("blocked");
			}),
			setItem: vi.fn(),
		};
		expect(getOrCreateStorageId(storage, "key", () => "memory-id")).toBe(
			"memory-id",
		);
	});

	it("keeps one generated id when persistence is unavailable", () => {
		const createId = vi.fn(() => "memory-id");
		const storage = {
			getItem: vi.fn(() => null),
			setItem: vi.fn(() => {
				throw new Error("blocked");
			}),
		};
		expect(getOrCreateStorageId(storage, "key", createId)).toBe("memory-id");
		expect(createId).toHaveBeenCalledOnce();
	});
});

describe("product page views", () => {
	it.each(["/", "/pricing", "/dashboard", "/dashboard/settings"])(
		"captures %s",
		(pathname) => {
			expect(shouldCaptureProductPageView(pathname)).toBe(true);
		},
	);

	it.each(["/s/video-id", "/c/comment-id", "/embed/video-id"])(
		"excludes high-volume viewer route %s",
		(pathname) => {
			expect(shouldCaptureProductPageView(pathname)).toBe(false);
		},
	);
});

describe("browser product analytics transport", () => {
	it("uses a beacon during unload without also fetching", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const sendBeacon = vi.fn(() => true);
		await expect(
			sendBrowserProductAnalytics([makeEvent(1)], "unload", {
				fetchImpl,
				sendBeacon,
			}),
		).resolves.toBe("success");
		expect(sendBeacon).toHaveBeenCalledOnce();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("falls back to keepalive fetch when a beacon is rejected", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 202 }));
		await expect(
			sendBrowserProductAnalytics([makeEvent(1)], "unload", {
				fetchImpl,
				sendBeacon: () => false,
			}),
		).resolves.toBe("success");
		expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ keepalive: true });
	});

	it.each([
		[429, "retry"],
		[503, "retry"],
		[400, "drop"],
	] as const)("maps HTTP %s to %s", async (status, result) => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status }));
		await expect(
			sendBrowserProductAnalytics([makeEvent(1)], "normal", { fetchImpl }),
		).resolves.toBe(result);
	});

	it("retries transport failures", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("offline"));
		await expect(
			sendBrowserProductAnalytics([makeEvent(1)], "normal", { fetchImpl }),
		).resolves.toBe("retry");
	});

	it("times out a stalled request", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		const result = sendBrowserProductAnalytics([makeEvent(1)], "normal", {
			fetchImpl,
		});
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(result).resolves.toBe("retry");
		vi.useRealTimers();
	});
});
