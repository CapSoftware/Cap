import { OpenPanel } from "@openpanel/web";
import { Store } from "~/electron/store";

const clientId = import.meta.env.VITE_OPENPANEL_CLIENT_ID as string | undefined;
const apiUrl = import.meta.env.VITE_OPENPANEL_API_URL as string | undefined;

let telemetryEnabledCache = true;

async function isTelemetryEnabled(): Promise<boolean> {
	try {
		const store = await Store.load("store");
		const settings =
			(await store.get<{ enableTelemetry?: boolean }>("general_settings")) ??
			null;
		telemetryEnabledCache = settings?.enableTelemetry !== false;
	} catch {
		// fall back to cached value; defaults to enabled
	}
	return telemetryEnabledCache;
}

// The SDK appends "/track" to `apiUrl`, so it must be a bare origin.
function normalizeApiUrl(url: string | undefined): string | undefined {
	const trimmed = url?.trim().replace(/\/+$/, "");
	return trimmed || undefined;
}

let openpanel: OpenPanel | undefined;

if (clientId && apiUrl) {
	try {
		openpanel = new OpenPanel({
			clientId,
			apiUrl: normalizeApiUrl(apiUrl),
			// This is a desktop webview, not a website: routes are internal
			// implementation detail and there are no outgoing links, so every
			// event is sent explicitly via `trackEvent`.
			trackScreenViews: false,
			trackOutgoingLinks: false,
			trackAttributes: false,
			// Backstop for the telemetry toggle. `trackEvent` checks it too, but
			// this also covers anything the SDK sends on its own.
			filter: () => telemetryEnabledCache,
		});
		console.log("OpenPanel initialized");
	} catch (error) {
		console.error("Failed to initialize OpenPanel:", error);
	}
}

export function initAnonymousUser() {
	if (!openpanel) {
		console.warn("Cannot initialize anonymous user - analytics not configured");
		return;
	}

	// OpenPanel assigns anonymous device profiles server-side, so there is no
	// client-generated anonymous id to manage. Drop the id PostHog used to
	// persist and warm the telemetry cache before the first event fires.
	try {
		localStorage.removeItem("anonymous_id");
	} catch {
		// localStorage is unavailable in some webview contexts; nothing to clean
	}
	void isTelemetryEnabled();
}

export function identifyUser(
	userId: string,
	properties?: Record<string, unknown>,
) {
	const op = openpanel;
	if (!op) {
		console.warn("Cannot identify user - analytics not configured");
		return;
	}

	if (!telemetryEnabledCache) return;

	void isTelemetryEnabled().then((enabled) => {
		if (!enabled) return;

		try {
			// Identifying merges the anonymous device profile into `profileId`,
			// so no aliasing step is needed.
			void Promise.resolve(
				op.identify({
					profileId: userId,
					...(properties ? { properties } : {}),
				}),
			).catch((error) => console.error("Error identifying user:", error));
			console.log(`User identified: ${userId}`);
		} catch (error) {
			console.error("Error identifying user:", error);
		}
	});
}

export function resetUser() {
	openpanel?.clear();
}

export function trackEvent(
	eventName: string,
	properties?: Record<string, unknown>,
) {
	const op = openpanel;
	if (!op) {
		console.warn("Event not captured - analytics not configured:", eventName);
		return;
	}

	if (!telemetryEnabledCache) {
		return;
	}

	void isTelemetryEnabled().then((enabled) => {
		if (!enabled) return;

		try {
			const eventProperties = { ...properties, platform: "desktop" };
			console.log(`Capturing event ${eventName}:`, eventProperties);
			void op
				.track(eventName, eventProperties)
				.catch((error) =>
					console.error(`Error capturing event ${eventName}:`, error),
				);
		} catch (error) {
			console.error(`Error capturing event ${eventName}:`, error);
		}
	});
}
