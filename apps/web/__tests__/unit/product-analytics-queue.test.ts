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
	properties: {
		hostname: "cap.so",
		is_session_entry: true,
		session_started_at: "2026-07-12T12:00:00.000Z",
	},
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
			accepted: 0,
		});
	});

	it("invokes native timer dependencies without binding the queue", async () => {
		let scheduled: (() => void) | undefined;
		const schedule = function (
			this: unknown,
			handler: Parameters<typeof setTimeout>[0],
		) {
			expect(this).toBeUndefined();
			if (typeof handler === "function") scheduled = handler;
			return setTimeout(() => {}, 0);
		} as typeof setTimeout;
		const transport = vi
			.fn<ProductAnalyticsTransport>()
			.mockResolvedValue("success");
		const queue = new ProductAnalyticsQueue(transport, schedule, clearTimeout);

		queue.enqueue(makeEvent(1));
		scheduled?.();
		await queue.flush();

		expect(transport).toHaveBeenCalledTimes(1);
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

	it("keeps an in-flight page view unload-safe during a fast exit", async () => {
		let resolveTransport: ((value: "success") => void) | undefined;
		const transport = vi.fn<ProductAnalyticsTransport>(
			() =>
				new Promise((resolve) => {
					resolveTransport = resolve;
				}),
		);
		const queue = new ProductAnalyticsQueue(transport);
		queue.enqueue(makeEvent(1));
		const pageViewFlush = queue.flush("keepalive");
		const exitFlush = queue.flush("unload");

		expect(exitFlush).toBe(pageViewFlush);
		expect(transport).toHaveBeenCalledWith(
			[expect.objectContaining({ eventId: "event-1" })],
			"keepalive",
			expect.any(Object),
		);
		resolveTransport?.("success");
		await pageViewFlush;
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

	it("keeps the browser enqueue path within its CPU budget", () => {
		vi.useRealTimers();
		const samples: number[] = [];
		for (let sample = 0; sample < 10; sample += 1) {
			const queue = new ProductAnalyticsQueue(
				() => new Promise(() => {}),
				(() =>
					0 as unknown as ReturnType<
						typeof setTimeout
					>) as unknown as typeof setTimeout,
				() => {},
			);
			const startedAt = performance.now();
			for (let index = 0; index < 1_000; index += 1) {
				queue.enqueue(makeEvent(index));
			}
			samples.push(performance.now() - startedAt);
		}
		const sorted = [...samples].sort((left, right) => left - right);
		const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
		console.info(
			`Browser analytics enqueue p95: ${p95Ms.toFixed(2)}ms for 1,000 events`,
		);
		expect(p95Ms).toBeLessThan(250);
	});

	it("recovers an unconfirmed in-flight batch after a page restart", async () => {
		vi.setSystemTime(new Date("2026-07-12T12:01:00.000Z"));
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			removeItem: (key: string) => values.delete(key),
			setItem: (key: string, value: string) => values.set(key, value),
		};
		const abandonedTransport = vi.fn<ProductAnalyticsTransport>(
			() => new Promise(() => {}),
		);
		const abandonedQueue = new ProductAnalyticsQueue(
			abandonedTransport,
			setTimeout,
			clearTimeout,
			storage,
		);
		abandonedQueue.enqueue({
			...makeEvent(1),
			properties: {
				hostname: "cap.so",
				is_session_entry: true,
				session_started_at: "2026-07-12T12:00:00.000Z",
			},
		});
		void abandonedQueue.flush("unload");

		const recoveredTransport = vi
			.fn<ProductAnalyticsTransport>()
			.mockResolvedValue("success");
		const recoveredQueue = new ProductAnalyticsQueue(
			recoveredTransport,
			setTimeout,
			clearTimeout,
			storage,
		);
		expect(recoveredQueue.size).toBe(1);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(recoveredTransport.mock.calls[0]?.[0][0]?.eventId).toBe("event-1");
		expect(recoveredQueue.deliverySnapshot).toMatchObject({
			attempted: 2,
			accepted: 1,
			retried: 1,
			dropped: 0,
		});
	});

	it("makes blocked queue persistence observable", () => {
		const storage = {
			getItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		const queue = new ProductAnalyticsQueue(
			vi.fn<ProductAnalyticsTransport>(),
			setTimeout,
			clearTimeout,
			storage,
		);
		queue.enqueue(makeEvent(1));
		expect(queue.deliverySnapshot.persistence_failed).toBeGreaterThan(0);
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
	it("treats an accepted unload beacon as unconfirmed for a stable-ID retry", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const sendBeacon = vi.fn(() => true);
		await expect(
			sendBrowserProductAnalytics([makeEvent(1)], "unload", {
				fetchImpl,
				sendBeacon,
			}),
		).resolves.toBe("retry");
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

	it("keeps an immediate page-view request alive without using a beacon", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 202 }));
		const sendBeacon = vi.fn(() => true);
		await expect(
			sendBrowserProductAnalytics([makeEvent(1)], "keepalive", {
				fetchImpl,
				sendBeacon,
			}),
		).resolves.toBe("success");
		expect(sendBeacon).not.toHaveBeenCalled();
		expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ keepalive: true });
	});

	it("returns per-event admission for a mixed conflict batch", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				accepted: 1,
				acceptedEventIds: ["event-1"],
				rejectedEventIds: ["event-2"],
			}),
		);
		await expect(
			sendBrowserProductAnalytics([makeEvent(1), makeEvent(2)], "normal", {
				fetchImpl,
			}),
		).resolves.toEqual({
			acceptedEventIds: ["event-1"],
			rejectedEventIds: ["event-2"],
		});
	});

	it.each([
		[404, "retry"],
		[410, "retry"],
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
