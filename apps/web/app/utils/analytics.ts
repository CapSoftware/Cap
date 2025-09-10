import posthog from "posthog-js";
import * as uuid from "uuid";
import { trackMetaEvent } from "../Layout/MetaPixel";

export function initAnonymousUser() {
	try {
		const anonymousId = localStorage.getItem("anonymous_id") ?? uuid.v4();
		localStorage.setItem("anonymous_id", anonymousId);
		posthog.identify(anonymousId);
	} catch (error) {
		console.error("Error initializing anonymous user:", error);
	}
}

export function identifyUser(userId: string, properties?: Record<string, any>) {
	try {
		const currentId = posthog.get_distinct_id();
		const anonymousId = localStorage.getItem("anonymous_id");

		if (currentId !== userId) {
			if (anonymousId && currentId === anonymousId) {
				posthog.alias(userId, anonymousId);
			}
			posthog.identify(userId);
			if (properties) {
				posthog.people.set(properties);
			}
			localStorage.removeItem("anonymous_id");
		}
	} catch (error) {
		console.error("Error identifying user:", error);
	}
}

export function trackEvent(
	eventName: string,
	properties?: Record<string, any>,
) {
	try {
		if (!posthog || typeof posthog.capture !== "function") {
			console.warn(`PostHog not available for event: ${eventName}`);
			return;
		}

		posthog.capture(eventName, { ...properties, platform: "web" });

		const metaEventMap: Record<string, string> = {
			purchase_completed: "Purchase",
			subscription_purchased: "Purchase",
			user_signed_up: "CompleteRegistration",
		};

		const metaEventName = metaEventMap[eventName];
		if (metaEventName) {
			trackMetaEvent(metaEventName, properties);
		}
	} catch (error) {
		console.error(`Error tracking event ${eventName}:`, error);
	}
}
