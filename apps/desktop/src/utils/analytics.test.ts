import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const state: {
		enableTelemetry: boolean;
		settingsListener?: (settings?: { enableTelemetry?: boolean }) => void;
	} = { enableTelemetry: true };

	return {
		state,
		fetch: vi.fn(async (_url: string, _request?: RequestInit) => ({
			ok: true,
			status: 202,
		})),
	};
});

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.5.6" }));
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
		mocks.fetch.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends a normalized core event through the first-party endpoint", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("create_shareable_link_clicked", {
			fps: 60,
			has_existing_auth: true,
			ignored: { nested: true },
		});
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(250);

		expect(mocks.fetch).toHaveBeenCalledOnce();
		const [url, request] = mocks.fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://cap.so/api/events");
		expect(request).toMatchObject({
			method: "POST",
			headers: {
				authorization: "Bearer token",
				"content-type": "application/json",
			},
		});
		const body = JSON.parse(String(request?.body));
		expect(body.events).toHaveLength(1);
		expect(body.events[0]).toMatchObject({
			eventName: "create_shareable_link_clicked",
			anonymousId: "install-id",
			sessionId: "process-session-id",
			platform: "desktop",
			appVersion: "0.5.6",
			properties: { fps: 60, has_existing_auth: true },
		});
	});

	it("drops events outside the bounded product catalog", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("camera_selected", { source: "dropdown" });
		await flushMicrotasks();
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("never accepts a client-authored revenue event", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("purchase_completed", { quantity: 10 });
		await flushMicrotasks();
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("drops permanent collector errors without retrying", async () => {
		mocks.fetch.mockResolvedValue({ ok: false, status: 400 });
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(mocks.fetch).toHaveBeenCalledOnce();
	});

	it("retries transient collector errors once", async () => {
		mocks.fetch.mockResolvedValue({ ok: false, status: 503 });
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(250);
		await vi.advanceTimersByTimeAsync(500);

		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("clears queued events as soon as telemetry is disabled", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		mocks.state.settingsListener?.({ enableTelemetry: false });
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("does not send events when telemetry starts disabled", async () => {
		mocks.state.enableTelemetry = false;
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
