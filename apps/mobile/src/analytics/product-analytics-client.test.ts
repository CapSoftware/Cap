import { describe, expect, it, vi } from "vitest";
import {
	MobileProductAnalyticsClient,
	type MobileProductAnalyticsState,
} from "./product-analytics-client";

const createHarness = (input?: {
	initialState?: MobileProductAnalyticsState | null;
	fetchImpl?: typeof fetch;
	queueCapacity?: number;
	requestTimeoutMs?: number;
	writeStateFails?: boolean;
	writeStateImpl?: (state: MobileProductAnalyticsState) => Promise<void>;
}) => {
	let state = input?.initialState ?? null;
	let id = 0;
	let now = Date.parse("2026-07-31T12:00:00.000Z");
	const timers: Array<{ callback: () => void; delayMs: number }> = [];
	const client = new MobileProductAnalyticsClient({
		readState: async () => state,
		writeState: async (nextState) => {
			if (input?.writeStateFails) throw new Error("disk unavailable");
			if (input?.writeStateImpl) {
				await input.writeStateImpl(structuredClone(nextState));
			}
			state = structuredClone(nextState);
		},
		createId: () => `event_${++id}`,
		getAppVersion: () => "1.2.3",
		fetchImpl: input?.fetchImpl,
		now: () => now,
		setTimer: (callback, delayMs) => {
			timers.push({ callback, delayMs });
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: vi.fn(),
		queueCapacity: input?.queueCapacity,
		requestTimeoutMs: input?.requestTimeoutMs,
	});
	return {
		client,
		getState: () => state,
		setNow: (value: number) => {
			now = value;
		},
		timers,
	};
};

describe("MobileProductAnalyticsClient", () => {
	it("persists the original event id through retry and restart", async () => {
		const firstFetch = vi.fn<typeof fetch>(() =>
			Promise.reject(new Error("offline")),
		);
		const first = createHarness({ fetchImpl: firstFetch });
		await first.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const eventId = await first.client.track("multipart_upload_complete", {
			duration: 12,
			length: 12,
			size: 1024,
		});
		await first.client.configure({
			apiKey: "mobile_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const afterRetry = await first.client.snapshot();
		expect(afterRetry.pending[0]?.event.eventId).toBe(eventId);
		expect(afterRetry.pending[0]?.attempts).toBe(1);
		expect(afterRetry.delivery.retried).toBe(1);

		const acceptedBodies: unknown[] = [];
		const second = createHarness({
			initialState: first.getState(),
			fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
				acceptedBodies.push(JSON.parse(String(init?.body)) as unknown);
				return Response.json({ accepted: 1 });
			}),
		});
		second.setNow(Date.parse("2026-07-31T12:00:02.000Z"));
		await second.client.configure({
			apiKey: "mobile_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		expect(
			(
				acceptedBodies[0] as {
					events: Array<{ eventId: string }>;
				}
			).events[0]?.eventId,
		).toBe(eventId);
		expect((await second.client.snapshot()).pending).toEqual([]);
	});

	it("moves permanent contract failures into a visible dead letter", async () => {
		const harness = createHarness({
			fetchImpl: vi.fn<typeof fetch>(
				async () => new Response(null, { status: 400 }),
			),
		});
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const eventId = await harness.client.track("user_signed_in");
		await harness.client.configure({
			apiKey: "mobile_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const snapshot = await harness.client.snapshot();
		expect(snapshot.pending).toEqual([]);
		expect(snapshot.delivery.contract_rejected).toBe(1);
		expect(snapshot.deadLetters).toEqual([
			expect.objectContaining({
				eventId,
				reason: "contract",
				status: 400,
			}),
		]);
	});

	it.each([429, 500])("retries a retryable %s response", async (status) => {
		const harness = createHarness({
			fetchImpl: vi.fn<typeof fetch>(
				async () => new Response(null, { status }),
			),
		});
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const eventId = await harness.client.track("user_signed_in");
		await harness.client.configure({
			apiKey: "mobile_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const snapshot = await harness.client.snapshot();
		expect(snapshot.pending[0]?.event.eventId).toBe(eventId);
		expect(snapshot.pending[0]?.attempts).toBe(1);
		expect(snapshot.delivery.retried).toBe(1);
	});

	it("aborts and retries a request that exceeds the timeout", async () => {
		const harness = createHarness({
			requestTimeoutMs: 250,
			fetchImpl: vi.fn<typeof fetch>(
				(_url, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							reject(new Error("aborted"));
						});
					}),
			),
		});
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const eventId = await harness.client.track("user_signed_in");
		const configuring = harness.client.configure({
			apiKey: "mobile_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await vi.waitFor(() => {
			expect(harness.timers.some((timer) => timer.delayMs === 250)).toBe(true);
		});
		harness.timers.find((timer) => timer.delayMs === 250)?.callback();
		await configuring;
		const snapshot = await harness.client.snapshot();
		expect(snapshot.pending[0]?.event.eventId).toBe(eventId);
		expect(snapshot.pending[0]?.attempts).toBe(1);
		expect(snapshot.delivery.retried).toBe(1);
	});

	it("dead-letters a critical event instead of silently dropping on overflow", async () => {
		const harness = createHarness({ queueCapacity: 1 });
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		const displacedId = await harness.client.track(
			"multipart_upload_complete",
			{ duration: 1, length: 1, size: 1 },
		);
		await harness.client.track("recording_started", {
			mode: "camera",
			target_kind: "camera",
			has_camera: true,
			has_mic: true,
			has_system_audio: false,
			target_fps: 30,
			target_width: 720,
			target_height: 1280,
			fragmented: true,
			custom_cursor_capture: false,
		});
		const snapshot = await harness.client.snapshot();
		expect(snapshot.pending).toHaveLength(1);
		expect(snapshot.delivery.queue_overflow).toBe(1);
		expect(snapshot.delivery.dropped).toBe(0);
		expect(snapshot.deadLetters).toEqual([
			expect.objectContaining({
				eventId: displacedId,
				reason: "queue_overflow",
			}),
		]);
	});

	it("reports observable best-effort loss on overflow", async () => {
		const harness = createHarness({ queueCapacity: 1 });
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await harness.client.track("user_signed_out");
		await harness.client.track("user_signed_out");
		const snapshot = await harness.client.snapshot();
		expect(snapshot.pending[0]?.event.eventName).toBe("user_signed_out");
		expect(snapshot.delivery.queue_overflow).toBe(1);
		expect(snapshot.delivery.dropped).toBe(1);
		expect(snapshot.deadLetters).toEqual([]);
	});

	it("isolates identities and pending events across accounts", async () => {
		const harness = createHarness();
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await harness.client.track("multipart_upload_complete", {
			duration: 1,
			length: 1,
			size: 1,
		});
		const firstSnapshot = await harness.client.snapshot();
		const firstAnonymousId = firstSnapshot.pending[0]?.event.anonymousId;
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_2",
			baseUrl: "https://cap.so",
		});
		await harness.client.track("user_signed_in");
		const snapshot = await harness.client.snapshot();
		expect(snapshot.pending).toHaveLength(2);
		expect(snapshot.pending[0]?.credentialScope).toBe("scope_1");
		expect(snapshot.pending[1]?.credentialScope).toBe("scope_2");
		expect(snapshot.pending[1]?.event.anonymousId).not.toBe(firstAnonymousId);

		await harness.client.purgeCredentialScope("scope_1");
		const purged = await harness.client.snapshot();
		expect(purged.pending).toHaveLength(1);
		expect(purged.pending[0]?.credentialScope).toBe("scope_2");
		expect(purged.anonymousIds.scope_1).toBeUndefined();
	});

	it("retains finalized ids and rejects changed payloads after acceptance", async () => {
		const harness = createHarness({
			fetchImpl: vi.fn<typeof fetch>(async () =>
				Response.json({ accepted: 1 }),
			),
		});
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await harness.client.trackWithId(
			"stable_event",
			"2026-07-31T12:00:00.000Z",
			"multipart_upload_complete",
			{ duration: 1, length: 1, size: 1 },
		);
		await harness.client.configure({
			apiKey: "mobile_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		expect((await harness.client.snapshot()).eventLedger).toEqual([
			expect.objectContaining({ eventId: "stable_event", outcome: "accepted" }),
		]);
		await expect(
			harness.client.trackWithId(
				"stable_event",
				"2026-07-31T12:00:00.000Z",
				"multipart_upload_complete",
				{ duration: 2, length: 1, size: 1 },
			),
		).rejects.toThrow("Conflicting mobile product analytics event id");
	});

	it("keeps credential failures pending for same-account reauthentication", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(Response.json({ accepted: 1 }));
		const harness = createHarness({ fetchImpl });
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await harness.client.track("user_signed_in");
		await harness.client.configure({
			apiKey: "expired_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		expect((await harness.client.snapshot()).pending).toHaveLength(1);
		harness.setNow(Date.parse("2026-07-31T12:00:02.000Z"));
		await harness.client.configure({
			apiKey: "replacement_key",
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		expect((await harness.client.snapshot()).pending).toEqual([]);
	});

	it("serializes persistence under concurrent tracking", async () => {
		let activeWrites = 0;
		let maxActiveWrites = 0;
		const harness = createHarness({
			writeStateImpl: async () => {
				activeWrites += 1;
				maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
				await Promise.resolve();
				activeWrites -= 1;
			},
		});
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await Promise.all([
			harness.client.track("user_signed_in"),
			harness.client.track("user_signed_out"),
		]);
		expect(maxActiveWrites).toBe(1);
		expect((await harness.client.snapshot()).pending).toHaveLength(2);
	});

	it("rejects the same pending event id with a different payload", async () => {
		const harness = createHarness();
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await harness.client.trackWithId(
			"stable_event",
			"2026-07-31T12:00:00.000Z",
			"multipart_upload_complete",
			{ duration: 1, length: 1, size: 1 },
		);
		await expect(
			harness.client.trackWithId(
				"stable_event",
				"2026-07-31T12:00:00.000Z",
				"multipart_upload_complete",
				{ duration: 2, length: 1, size: 1 },
			),
		).rejects.toThrow("Conflicting mobile product analytics event id");
	});

	it("does not acknowledge a critical event when local persistence fails", async () => {
		const harness = createHarness({ writeStateFails: true });
		await harness.client.configure({
			apiKey: null,
			credentialScope: "scope_1",
			baseUrl: "https://cap.so",
		});
		await expect(
			harness.client.track("multipart_upload_complete", {
				duration: 1,
				length: 1,
				size: 1,
			}),
		).rejects.toThrow("Critical mobile analytics persistence failed");
		const snapshot = await harness.client.snapshot();
		expect(snapshot.pending).toHaveLength(1);
		expect(snapshot.delivery.persistence_failed).toBe(1);
	});
});
