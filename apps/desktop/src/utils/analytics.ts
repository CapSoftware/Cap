import {
	type ClientProductEventNameForPlatform,
	isCoreEventName,
	isServerOnlyEventName,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_CLIENT_SCHEMA_VERSION,
	type ProductEventArguments,
	type ProductEventInput,
} from "@cap/analytics";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { Store } from "@tauri-apps/plugin-store";
import { v4 as uuid } from "uuid";

import { generalSettingsStore } from "~/store";
import { ProductAnalyticsQueue } from "./product-analytics";
import { getConfiguredServerUrl, maybeProtectedHeaders } from "./web-api";

const PRODUCT_ANALYTICS_REQUEST_TIMEOUT_MS = 3000;

let telemetryEnabledCache = true;
let telemetryStateReady = false;
let telemetryStatePromise: Promise<void> | undefined;
let anonymousIdPromise: Promise<string> | undefined;
let appVersionPromise: Promise<string | undefined> | undefined;
let productSessionIdPromise: Promise<string> | undefined;
let fallbackAnonymousIdValue: string | undefined;
let activeProductRequest: AbortController | undefined;

const productAnalyticsQueue = new ProductAnalyticsQueue({
	sendBatch: sendProductEventBatch,
	isEnabled: isTelemetryEnabled,
});

function applyTelemetryState(enabled: boolean) {
	telemetryEnabledCache = enabled;
	if (!enabled) {
		productAnalyticsQueue.clear();
		activeProductRequest?.abort();
	}
}

async function initializeTelemetryState() {
	if (telemetryStatePromise) return telemetryStatePromise;

	telemetryStatePromise = (async () => {
		try {
			const store = await Store.load("store");
			const settings = await store.get<{ enableTelemetry?: boolean }>(
				"general_settings",
			);
			applyTelemetryState(settings?.enableTelemetry !== false);
			await store.onKeyChange<{ enableTelemetry?: boolean }>(
				"general_settings",
				(settings) => applyTelemetryState(settings?.enableTelemetry !== false),
			);
		} catch {
			applyTelemetryState(telemetryEnabledCache);
		} finally {
			telemetryStateReady = true;
		}
	})();

	return telemetryStatePromise;
}

async function isTelemetryEnabled() {
	if (!telemetryStateReady) await initializeTelemetryState();
	return telemetryEnabledCache;
}

function fallbackAnonymousId() {
	if (fallbackAnonymousIdValue) return fallbackAnonymousIdValue;
	try {
		const storage = getAnalyticsStorage();
		const existing = storage?.getItem("anonymous_id");
		if (existing) {
			fallbackAnonymousIdValue = existing;
			return existing;
		}
	} catch {}

	fallbackAnonymousIdValue = uuid();
	try {
		getAnalyticsStorage()?.setItem("anonymous_id", fallbackAnonymousIdValue);
	} catch {}
	return fallbackAnonymousIdValue;
}

function getAnalyticsStorage() {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

async function getAnonymousId() {
	if (!anonymousIdPromise) {
		anonymousIdPromise = generalSettingsStore
			.get()
			.then((settings) => settings?.instanceId ?? fallbackAnonymousId())
			.then((anonymousId) => {
				getAnalyticsStorage()?.setItem("anonymous_id", anonymousId);
				return anonymousId;
			})
			.catch(fallbackAnonymousId);
	}
	return anonymousIdPromise;
}

async function getAppVersion() {
	if (!appVersionPromise) {
		appVersionPromise = getVersion().catch(() => undefined);
	}
	return appVersionPromise;
}

async function getProductSessionId() {
	if (!productSessionIdPromise) {
		productSessionIdPromise = Store.load("store")
			.then((store) => store.get<string>("product_analytics_session_id"))
			.then((stored) => stored ?? uuid())
			.catch(uuid);
	}
	return productSessionIdPromise;
}

async function sendProductEventBatch(events: ProductEventInput[]) {
	if (!(await isTelemetryEnabled())) return;

	const controller = new AbortController();
	activeProductRequest = controller;
	const timeout = setTimeout(
		() => controller.abort(),
		PRODUCT_ANALYTICS_REQUEST_TIMEOUT_MS,
	);

	try {
		const { authorization } = await maybeProtectedHeaders();
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (authorization) headers.authorization = authorization;

		const response = await fetch(
			new URL("/api/events", await getConfiguredServerUrl()).toString(),
			{
				method: "POST",
				headers,
				body: JSON.stringify({ events }),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			if (response.status === 429 || response.status >= 500) {
				throw new Error(`Product analytics returned ${response.status}`);
			}
		}
	} finally {
		clearTimeout(timeout);
		if (activeProductRequest === controller) activeProductRequest = undefined;
	}
}

async function enqueueProductEvent(
	eventId: string,
	eventName: ClientProductEventNameForPlatform<"desktop">,
	occurredAt: string,
	properties?: Record<string, unknown>,
) {
	if (!isCoreEventName(eventName) || isServerOnlyEventName(eventName)) return;

	const [anonymousId, appVersion, productSessionId] = await Promise.all([
		getAnonymousId(),
		getAppVersion(),
		getProductSessionId(),
	]);
	if (!telemetryEnabledCache) return;

	const normalizedProperties = normalizeProductEventProperties(
		eventName,
		properties,
	);
	if (normalizedProperties === null) return;
	productAnalyticsQueue.enqueue({
		eventId,
		eventName,
		occurredAt,
		anonymousId,
		schemaVersion: PRODUCT_ANALYTICS_CLIENT_SCHEMA_VERSION,
		sessionId: productSessionId,
		platform: "desktop",
		...(appVersion ? { appVersion } : {}),
		...(normalizedProperties ? { properties: normalizedProperties } : {}),
	});
}

export function trackEvent<
	Name extends ClientProductEventNameForPlatform<"desktop">,
>(eventName: Name, ...args: ProductEventArguments<Name>) {
	const eventId = uuid();
	const occurredAt = new Date().toISOString();
	if (!isCoreEventName(eventName) || isServerOnlyEventName(eventName)) return;
	const normalizedProperties = normalizeProductEventProperties(
		eventName,
		args[0] as Record<string, unknown> | undefined,
	);
	if (normalizedProperties === null) return;

	void isTelemetryEnabled().then((enabled) => {
		if (!enabled) return;
		void invoke("capture_client_product_analytics_event", {
			eventId,
			eventName,
			occurredAt,
			properties: JSON.stringify(normalizedProperties ?? {}),
		}).catch(() =>
			enqueueProductEvent(
				eventId,
				eventName,
				occurredAt,
				normalizedProperties as Record<string, unknown> | undefined,
			),
		);
	});
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => void productAnalyticsQueue.flush());
}

void initializeTelemetryState();
