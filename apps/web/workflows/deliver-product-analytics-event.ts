import {
	ProductAnalyticsError,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import { serverEnv } from "@cap/env";
import { FatalError } from "workflow";
import { start } from "workflow/api";
import {
	createServerProductEventRows,
	type ServerProductEvent,
} from "@/lib/analytics/server-event";

export async function deliverProductAnalyticsEventStep(
	event: ServerProductEvent,
) {
	"use step";

	const rows = createServerProductEventRows(event);
	if (rows.length !== 1) {
		throw new FatalError("Product analytics event failed contract validation");
	}
	const env = serverEnv();
	const host = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
	const token = env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN;
	if (!host || !token) {
		throw new FatalError("Product analytics delivery is not configured");
	}

	try {
		await sendProductAnalyticsRows({
			host,
			token,
			rows,
			wait: true,
			maxAttempts: 1,
		});
	} catch (error) {
		if (error instanceof ProductAnalyticsError && !error.retryable) {
			throw new FatalError(
				`Product analytics permanently rejected event with status ${error.status ?? "unknown"}`,
			);
		}
		throw new Error("Product analytics delivery temporarily failed");
	}

	return { eventId: event.eventId };
}
deliverProductAnalyticsEventStep.maxRetries = 8;

export async function enqueueProductAnalyticsEventStep(
	event: ServerProductEvent,
) {
	"use step";

	const run = await start(deliverProductAnalyticsEventWorkflow, [event]);
	return { eventId: event.eventId, runId: run.runId };
}
enqueueProductAnalyticsEventStep.maxRetries = 8;

export const enqueueReconciledProductAnalyticsEventStep =
	enqueueProductAnalyticsEventStep;

export async function deliverProductAnalyticsEventWorkflow(
	event: ServerProductEvent,
) {
	"use workflow";

	return deliverProductAnalyticsEventStep(event);
}
