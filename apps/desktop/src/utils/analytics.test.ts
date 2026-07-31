import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const state: {
		enableTelemetry: boolean;
		settingsListener?: (settings?: { enableTelemetry?: boolean }) => void;
	} = { enableTelemetry: true };

	return {
		state,
		invoke: vi.fn(
			async (
				_command: string,
				_input?: {
					eventId?: string;
					eventName?: string;
					occurredAt?: string;
					properties?: string;
				},
			) => undefined,
		),
		fetch: vi.fn(async (_url: string, _request?: RequestInit) => ({
			ok: true,
			status: 202,
		})),
	};
});

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.5.6" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("@tauri-apps/plugin-store", () => ({
	Store: {
		load: async () => ({
			get: async (key: string) =>
				key === "product_analytics_session_id"
					? "process-session-id"
					: { enableTelemetry: mocks.state.enableTelemetry },
			onKeyChange: async (
				_key: string,
				listener: (settings?: { enableTelemetry?: boolean }) => void,
			) => {
				mocks.state.settingsListener = listener;
				return () => {};
			},
		}),
	},
}));
vi.mock("~/store", () => ({
	generalSettingsStore: {
		get: async () => ({ instanceId: "install-id" }),
	},
}));
vi.mock("./web-api", () => ({
	getConfiguredServerUrl: async () => "https://cap.so",
	maybeProtectedHeaders: async () => ({ authorization: "Bearer token" }),
}));

async function flushMicrotasks() {
	for (let index = 0; index < 10; index++) await Promise.resolve();
}

async function loadAnalytics() {
	const analytics = await import("./analytics");
	await flushMicrotasks();
	return analytics;
}

describe("desktop analytics", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		mocks.state.enableTelemetry = true;
		mocks.state.settingsListener = undefined;
		mocks.invoke.mockReset();
		mocks.invoke.mockResolvedValue(undefined);
		mocks.fetch.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("persists a normalized core event through the native outbox", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("create_shareable_link_clicked", {
			resolution: "1080p",
			fps: 60,
			has_existing_auth: true,
		});
		await flushMicrotasks();

		expect(mocks.invoke).toHaveBeenCalledOnce();
		const [command, input] = mocks.invoke.mock.calls[0] ?? [];
		expect(command).toBe("capture_client_product_analytics_event");
		expect(input).toMatchObject({
			eventName: "create_shareable_link_clicked",
			properties: JSON.stringify({
				resolution: "1080p",
				fps: 60,
				has_existing_auth: true,
			}),
		});
		expect(input?.eventId).toMatch(/^[0-9a-f-]{36}$/);
		expect(input?.occurredAt).toEqual(expect.any(String));
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("sends registered finite desktop interactions", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("camera_selected", { enabled: true });
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(250);

		expect(mocks.invoke).toHaveBeenCalledOnce();
	});

	it("never accepts a client-authored revenue event", async () => {
		const { trackEvent } = await loadAnalytics();
		const unsafeTrackEvent = trackEvent as unknown as (
			eventName: string,
			properties?: Record<string, unknown>,
		) => void;
		unsafeTrackEvent("purchase_completed", { quantity: 10 });
		await flushMicrotasks();
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it("drops permanent collector errors without retrying", async () => {
		mocks.invoke.mockRejectedValue(new Error("native bridge unavailable"));
		mocks.fetch.mockResolvedValue({ ok: false, status: 400 });
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(mocks.fetch).toHaveBeenCalledOnce();
	});

	it("retries transient collector errors once", async () => {
		mocks.invoke.mockRejectedValue(new Error("native bridge unavailable"));
		mocks.fetch.mockResolvedValue({ ok: false, status: 503 });
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(250);
		await vi.advanceTimersByTimeAsync(500);

		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("clears queued events as soon as telemetry is disabled", async () => {
		mocks.invoke.mockRejectedValue(new Error("native bridge unavailable"));
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		mocks.state.settingsListener?.({ enableTelemetry: false });
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledOnce();
	});

	it("does not send events when telemetry starts disabled", async () => {
		mocks.state.enableTelemetry = false;
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});
