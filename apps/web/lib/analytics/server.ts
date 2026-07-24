import {
	PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import { serverEnv } from "@cap/env";
import { after, type NextRequest } from "next/server";
import {
	createServerProductEventRows,
	normalizeServerIdentifier,
	type ServerProductEvent,
} from "./server-event";

export { createServerProductEventRows } from "./server-event";

export async function captureServerProductEvent(event: ServerProductEvent) {
	const rows = createServerProductEventRows(event);
	if (rows.length === 0) return false;
	const env = serverEnv();
	const host = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
	const token = env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN;
	if (!host || !token) return false;

	await sendProductAnalyticsRows({ host, token, rows });
	return true;
}

export function scheduleServerProductEvent(event: ServerProductEvent) {
	scheduleAfterResponse(async () => {
		try {
			await captureServerProductEvent(event);
		} catch (error) {
			console.error(`Failed to capture ${event.eventName}`, error);
		}
	});
}

export function scheduleAfterResponse(task: () => Promise<void>) {
	try {
		after(task);
	} catch (error) {
		console.error("Failed to schedule analytics after response", error);
		void task().catch((taskError) =>
			console.error("Fallback analytics task failed", taskError),
		);
	}
}

export function readAnalyticsAnonymousId(request: NextRequest) {
	return normalizeServerIdentifier(
		request.cookies.get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value,
	);
}
