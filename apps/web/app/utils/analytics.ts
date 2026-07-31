import type {
	ClientProductEventName,
	ProductEventArguments,
	ProductEventPropertiesFor,
} from "@cap/analytics";
import { captureProductEvent } from "./product-analytics";

export function trackEvent<Name extends ClientProductEventName>(
	eventName: Name,
	...args: ProductEventArguments<Name>
) {
	captureProductEvent(eventName, ...args);
}

export function trackToolInteraction(
	properties: ProductEventPropertiesFor<"tool_interaction">,
) {
	trackEvent("tool_interaction", properties);
}

export function analyticsByteSizeBucket(bytes: number | undefined) {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0)
		return "unknown";
	if (bytes < 10 * 1024 * 1024) return "under_10mb";
	if (bytes < 50 * 1024 * 1024) return "10mb_to_50mb";
	if (bytes < 100 * 1024 * 1024) return "50mb_to_100mb";
	if (bytes < 500 * 1024 * 1024) return "100mb_to_500mb";
	return "500mb_or_more";
}

export function analyticsMimeCategory(mimeType: string | undefined) {
	const category = mimeType?.split("/", 1)[0];
	return category && ["audio", "image", "video"].includes(category)
		? category
		: "other";
}
