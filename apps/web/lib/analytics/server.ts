import { PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE } from "@cap/analytics";
import type { NextRequest } from "next/server";
import { start } from "workflow/api";
import { deliverProductAnalyticsEventWorkflow } from "@/workflows/deliver-product-analytics-event";
import {
	normalizeServerIdentifier,
	type ServerProductEvent,
} from "./server-event";

export { createServerProductEventRows } from "./server-event";

export async function queueServerProductEvent(event: ServerProductEvent) {
	const run = await start(deliverProductAnalyticsEventWorkflow, [event]);
	return { eventId: event.eventId, runId: run.runId };
}

export function readAnalyticsAnonymousId(request: NextRequest) {
	return normalizeServerIdentifier(
		request.cookies.get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value,
	);
}
