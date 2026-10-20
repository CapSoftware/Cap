import { buildEnv, serverEnv } from "@cap/env";
import { OpenPanel } from "@openpanel/sdk";
import { after } from "next/server";

// The SDK's fetch has no timeout and retries with backoff, so a hung
// OpenPanel endpoint would otherwise pin the function until the platform
// kills it. The race below is the delivery bound.
const DELIVERY_TIMEOUT_MS = 5_000;

async function deliver(
	distinctId: string,
	event: string,
	properties?: Record<string, unknown>,
): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const clientId = buildEnv.NEXT_PUBLIC_OPENPANEL_CLIENT_ID;
		const clientSecret = serverEnv().OPENPANEL_CLIENT_SECRET;
		const apiUrl = buildEnv.NEXT_PUBLIC_OPENPANEL_API_URL;
		if (!clientId || !clientSecret || !apiUrl) return;

		const op = new OpenPanel({ clientId, clientSecret, apiUrl });
		await Promise.race([
			op.track(event, { profileId: distinctId, ...properties }),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, DELIVERY_TIMEOUT_MS);
			}),
		]);
	} catch (error) {
		console.error(`Failed to track ${event} in OpenPanel:`, error);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Never blocks the caller: the event starts sending immediately, but the
 * response is not held for it — `after()` keeps the serverless function
 * alive until delivery settles, which plain fire-and-forget would not
 * survive (the runtime freezes once the response is sent).
 */
export function trackServerEvent(
	distinctId: string,
	event: string,
	properties?: Record<string, unknown>,
): void {
	const delivery = deliver(distinctId, event, properties);
	try {
		after(delivery);
	} catch {
		// Outside a request scope (scripts, tests): nothing to keep alive.
		void delivery;
	}
}
