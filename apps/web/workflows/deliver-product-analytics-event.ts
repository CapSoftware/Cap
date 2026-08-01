import { queueDurableServerProductEvent } from "@/lib/analytics/product-event-outbox";
import type { ServerProductEvent } from "@/lib/analytics/server-event";

export async function enqueueProductAnalyticsEventStep(
	event: ServerProductEvent,
) {
	return queueDurableServerProductEvent(event);
}

export const enqueueReconciledProductAnalyticsEventStep =
	enqueueProductAnalyticsEventStep;
