import { PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE } from "@cap/analytics";
import type { NextRequest } from "next/server";
import { queueDurableServerProductEvent } from "./product-event-outbox";
import {
	normalizeServerIdentifier,
	type ServerProductEvent,
} from "./server-event";

export { createServerProductEventRows } from "./server-event";

export async function queueServerProductEvent(event: ServerProductEvent) {
	const result = await queueDurableServerProductEvent(event);
	return {
		...result,
		runId:
			"runId" in result && result.runId
				? result.runId
				: `outbox:${"deliveryKey" in result ? result.deliveryKey : "suppressed"}`,
	};
}

export function readAnalyticsAnonymousId(request: NextRequest) {
	return normalizeServerIdentifier(
		request.cookies.get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value,
	);
}
