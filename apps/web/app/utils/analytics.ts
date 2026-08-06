/**
 * Thin wrapper over the OpenPanel browser SDK.
 *
 * The SDK is injected by `<OpenPanelComponent />` in the root layout, which
 * installs a `window.op` queue stub before the script finishes loading. When
 * `NEXT_PUBLIC_OPENPANEL_CLIENT_ID` is unset the component renders nothing, so
 * `window.op` never exists and every helper below becomes a no-op — self-hosted
 * Cap ships analytics-inert.
 */

import type { IdentifyPayload, TrackProperties } from "@openpanel/sdk";

/** The subset of the `window.op` queue API we use. */
type OpenPanelQueue = {
	(method: "track", name: string, properties?: TrackProperties): void;
	(method: "identify", payload: IdentifyPayload): void;
	(method: "clear"): void;
};

export type AnalyticsUser = {
	id: string;
	email?: string | null;
	name?: string | null;
	lastName?: string | null;
};

function getOpenPanel(): OpenPanelQueue | undefined {
	if (typeof window === "undefined") return undefined;
	const op: unknown = (window as unknown as { op?: unknown }).op;
	return typeof op === "function" ? (op as OpenPanelQueue) : undefined;
}

export function identifyUser(
	user: AnalyticsUser,
	properties?: Record<string, unknown>,
) {
	try {
		const op = getOpenPanel();
		if (!op) return;

		// OpenPanel merges the anonymous device profile into the identified
		// profile automatically, so no aliasing dance is needed here.
		op("identify", {
			profileId: user.id,
			...(user.email ? { email: user.email } : {}),
			...(user.name ? { firstName: user.name } : {}),
			...(user.lastName ? { lastName: user.lastName } : {}),
			...(properties ? { properties } : {}),
		});
	} catch (error) {
		console.error("Error identifying user:", error);
	}
}

/** Drops the identified profile + session. Call this on sign out. */
export function resetUser() {
	try {
		getOpenPanel()?.("clear");
	} catch (error) {
		console.error("Error resetting analytics user:", error);
	}
}

export function trackEvent(
	eventName: string,
	properties?: Record<string, any>,
) {
	try {
		const op = getOpenPanel();
		if (!op) return;

		op("track", eventName, { platform: "web", ...properties });
	} catch (error) {
		console.error(`Error tracking event ${eventName}:`, error);
	}
}
