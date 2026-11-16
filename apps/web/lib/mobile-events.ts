import type { Mobile } from "@cap/web-domain";
import type { ClientEvent } from "@/lib/server-analytics";

type MobileEventsInput = (typeof Mobile.MobileEventsInput)["Type"];

const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROPERTIES = 16;
const PROPERTY_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const SCREEN_NAME = /^[a-z][a-z0-9_]{0,39}(\/[a-z][a-z0-9_]{0,39}){0,3}$/;

// OpenPanel still reads these two without their `__` prefix, as the page path
// and referrer sent by its oldest SDKs. Every `__` key is already rejected by
// PROPERTY_KEY, so these are the only names an app could use to override them.
const RESERVED_PROPERTY_KEYS = new Set(["path", "referrer"]);

// A Safari-style platform token: OpenPanel derives the device, brand and OS
// from the user agent, and treats one it cannot place as a server, which gets
// no device, session or location.
export function mobileUserAgent(app: MobileEventsInput["app"]): string {
	const os = app.os.replaceAll(".", "_");
	const platform =
		app.device === "tablet"
			? `iPad; CPU OS ${os}`
			: `iPhone; CPU iPhone OS ${os}`;
	return `Cap-iOS/${app.version} (${platform} like Mac OS X; Apple)`;
}

export function prepareMobileEvents(
	input: MobileEventsInput,
	now: number,
): ClientEvent[] {
	const events: ClientEvent[] = [];
	for (const event of input.events) {
		// Both times come from the phone's clock, so their difference is the
		// event's age even when that clock is wrong.
		const age = Math.max(0, input.sentAt - event.timestamp);
		if (age > MAX_EVENT_AGE_MS) continue;

		const properties: ClientEvent["properties"] = {};
		let kept = 0;
		for (const [key, value] of Object.entries(event.properties ?? {})) {
			if (kept === MAX_PROPERTIES) break;
			if (!PROPERTY_KEY.test(key) || RESERVED_PROPERTY_KEYS.has(key)) continue;
			properties[key] = value;
			kept += 1;
		}

		const screen = properties.screen;
		if (
			event.name === "screen_view" &&
			typeof screen === "string" &&
			SCREEN_NAME.test(screen)
		) {
			properties.__path = `/${screen}`;
		}

		properties.platform = "ios";
		properties.app_version = input.app.version;
		properties.app_build = input.app.build;

		events.push({
			name: event.name,
			timestamp: new Date(now - age),
			properties,
		});
	}
	return events;
}
