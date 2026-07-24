import { trackMetaEvent } from "../Layout/MetaPixel";
import {
	captureProductEvent,
	getProductAnalyticsAnonymousId,
} from "./product-analytics";

export function trackEvent(
	eventName: string,
	properties?: Record<string, unknown>,
) {
	captureProductEvent(eventName, properties);
	const metaEventMap: Record<string, string> = {
		purchase_completed: "Purchase",
		subscription_purchased: "Purchase",
		user_signed_up: "CompleteRegistration",
	};
	const metaEventName = metaEventMap[eventName];
	if (!metaEventName) return;

	const isSignup = eventName === "user_signed_up";
	const eventId = isSignup
		? `signup_${getProductAnalyticsAnonymousId()}`
		: undefined;
	trackMetaEvent(
		metaEventName,
		isSignup ? undefined : properties,
		eventId ? { eventId } : undefined,
	);
}
