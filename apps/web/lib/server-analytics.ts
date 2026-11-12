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

function clientEventsConfig() {
	const clientId = buildEnv.NEXT_PUBLIC_OPENPANEL_CLIENT_ID;
	const clientSecret = serverEnv().OPENPANEL_CLIENT_SECRET;
	const apiUrl = buildEnv.NEXT_PUBLIC_OPENPANEL_API_URL?.replace(/\/+$/, "");
	return clientId && clientSecret && apiUrl
		? { clientId, clientSecret, apiUrl }
		: null;
}

export const acceptsClientEvents = () => clientEventsConfig() !== null;

export type ClientEvent = {
	name: string;
	timestamp: Date;
	properties: Record<string, string | number | boolean>;
};

export type ClientEventBatch = {
	profileId: string;
	userAgent: string;
	ip: string | undefined;
	events: ClientEvent[];
};

const CLIENT_BATCH_TIMEOUT_MS = 8_000;
const CLIENT_BATCH_CONCURRENCY = 8;

/**
 * Forwards events an app recorded on a device. Unlike `trackServerEvent`, the
 * user agent and address of that device go with them, so OpenPanel gives them
 * a device, a session and a location, and each keeps the time it happened.
 *
 * Resolves to how many events OpenPanel took, or `null` when analytics is not
 * configured. The caller awaits it: an app that hears nothing was stored keeps
 * the batch and sends it again.
 */
export async function sendClientEvents(
	batch: ClientEventBatch,
): Promise<{ sent: number; failed: number } | null> {
	const config = clientEventsConfig();
	if (!config) return null;
	const { clientId, clientSecret, apiUrl } = config;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"openpanel-client-id": clientId,
		"openpanel-client-secret": clientSecret,
		"openpanel-sdk-name": "cap",
		"User-Agent": batch.userAgent,
	};
	if (batch.ip) headers["openpanel-client-ip"] = batch.ip;

	const signal = AbortSignal.timeout(CLIENT_BATCH_TIMEOUT_MS);
	const pending = batch.events[Symbol.iterator]();
	let sent = 0;
	let lastError: unknown;

	const worker = async () => {
		for (const event of pending) {
			try {
				const response = await fetch(`${apiUrl}/track`, {
					method: "POST",
					headers,
					signal,
					body: JSON.stringify({
						type: "track",
						payload: {
							name: event.name,
							profileId: batch.profileId,
							properties: {
								...event.properties,
								__timestamp: event.timestamp.toISOString(),
							},
						},
					}),
				});
				if (response.ok) sent += 1;
			} catch (error) {
				lastError = error;
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(CLIENT_BATCH_CONCURRENCY, batch.events.length) },
			worker,
		),
	);

	const failed = batch.events.length - sent;
	if (failed > 0) {
		console.error(
			`Failed to deliver ${failed} of ${batch.events.length} client events to OpenPanel`,
			lastError ?? "",
		);
	}
	return { sent, failed };
}
