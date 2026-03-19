import posthog from "posthog-js";
import { v4 as uuid } from "uuid";

const key = import.meta.env.VITE_POSTHOG_KEY as string;
const host = import.meta.env.VITE_POSTHOG_HOST as string;

let isPostHogInitialized = false;

if (key && host) {
	try {
		posthog.init(key, {
			api_host: host,
			capture_pageview: false,
			loaded: (_posthogInstance) => {
				isPostHogInitialized = true;
			},
		});
		console.log("PostHog initialization started");
	} catch (error) {
		console.error("Failed to initialize PostHog:", error);
	}
}

export function initAnonymousUser() {
	if (!key || !host) {
		console.warn("Cannot initialize anonymous user - missing key or host");
		return;
	}

	try {
		const anonymousId = localStorage.getItem("anonymous_id") ?? uuid();
		localStorage.setItem("anonymous_id", anonymousId);
		posthog.identify(anonymousId);
		console.log("Anonymous user identified:", anonymousId);
	} catch (error) {
		console.error("Error initializing anonymous user:", error);
	}
}

export function identifyUser(userId: string, properties?: Record<string, any>) {
	if (!key || !host) {
		console.warn("Cannot identify user - missing key or host");
		return;
	}

	try {
		const currentId = posthog.get_distinct_id();
		const anonymousId = localStorage.getItem("anonymous_id");

		if (currentId !== userId) {
			if (anonymousId && currentId === anonymousId) {
				console.log(`Aliasing user ${userId} from anonymous ID ${anonymousId}`);
				posthog.alias(userId, anonymousId);
			}
			posthog.identify(userId);
			if (properties) {
				posthog.people.set(properties);
			}
			localStorage.removeItem("anonymous_id");
			console.log(`User identified: ${userId}`);
		} else {
			console.log(`User already identified as ${userId}`);
		}
	} catch (error) {
		console.error("Error identifying user:", error);
	}
}

export function trackEvent(
	eventName: string,
	properties?: Record<string, any>,
) {
	if (!key || !host) {
		console.warn(
			"PostHog event not captured - missing key or host:",
			eventName,
		);
		return;
	}

	try {
		if (!isPostHogInitialized) {
			console.warn(`PostHog not initialized yet, queuing event: ${eventName}`);
			// Queue the event to be sent when PostHog is initialized
			setTimeout(() => {
				console.log(`Retrying event ${eventName} after delay`);
				trackEvent(eventName, properties);
			}, 1000);
			return;
		}

		const eventProperties = { ...properties, platform: "desktop" };
		console.log(`Capturing event ${eventName}:`, eventProperties);
		posthog.capture(eventName, eventProperties);
	} catch (error) {
		console.error(`Error capturing event ${eventName}:`, error);
	}
}
