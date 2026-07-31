import { captureProductEvent } from "./product-analytics";

export function trackEvent(
	eventName: string,
	properties?: Record<string, unknown>,
) {
	captureProductEvent(eventName, properties);
}
