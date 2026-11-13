import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { developerApps, developerWebhookEndpoints } from "@cap/database/schema";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import {
	checkWebhookUrl,
	recordWebhookDelivery,
	sendDeveloperWebhook,
	type WebhookGuards,
	type WebhookSendResult,
	type WebhookUrlProblem,
	webhookUrlProblemMessage,
} from "@/lib/developer-webhook-delivery";
import {
	MAX_WEBHOOK_ENDPOINTS_PER_APP,
	WEBHOOK_EVENT_TYPES,
	WEBHOOK_TEST_EVENT_TYPE,
	type WebhookEventType,
} from "@/lib/developer-webhook-events";
import {
	createWebhookSecret,
	createWebhookTestEventId,
} from "@/lib/developer-webhook-signature";

export type WebhookEndpointRow = typeof developerWebhookEndpoints.$inferSelect;

export type WebhookFailure = {
	ok: false;
	status: 400 | 404 | 409;
	code: string;
	message: string;
	hint: string;
};

const SECRET_PREFIX_LENGTH = 12;

const failure = (
	status: WebhookFailure["status"],
	code: string,
	message: string,
	hint: string,
): WebhookFailure => ({ ok: false, status, code, message, hint });

const notFound = () =>
	failure(
		404,
		"webhook_not_found",
		"Webhook endpoint not found",
		"Check the endpoint ID and that it belongs to this app. Deleted endpoints are not returned.",
	);

const URL_HINTS: Record<WebhookUrlProblem, string> = {
	invalid_url:
		"Send a full URL of at most 2,048 characters, such as https://example.com/webhooks/cap.",
	https_required: "Webhooks are only sent over https.",
	credentials_in_url:
		"Remove the username and password. Verify each request with its Cap-Signature header instead.",
	unsupported_port: "Serve the endpoint on port 443 and leave the port out.",
	private_address:
		"The host must resolve to a public internet address. Private, loopback, link-local and reserved addresses are refused.",
};

const invalidUrl = (problem: WebhookUrlProblem) =>
	failure(
		400,
		"invalid_webhook_url",
		webhookUrlProblemMessage(problem),
		URL_HINTS[problem],
	);

export function serializeWebhookEndpoint(endpoint: WebhookEndpointRow) {
	return {
		id: endpoint.id,
		url: endpoint.url,
		events: endpoint.events,
		enabled: endpoint.enabled,
		disabledReason: endpoint.disabledReason,
		secretPrefix: endpoint.secretPrefix,
		lastDeliveryAt: endpoint.lastDeliveryAt,
		lastDeliveryStatus: endpoint.lastDeliveryStatus,
		lastResponseStatus: endpoint.lastResponseStatus,
		lastErrorCode: endpoint.lastErrorCode,
		consecutiveFailures: endpoint.consecutiveFailures,
		createdAt: endpoint.createdAt,
		updatedAt: endpoint.updatedAt,
	};
}

const liveEndpoint = (appId: string, endpointId: string) =>
	and(
		eq(developerWebhookEndpoints.id, endpointId),
		eq(developerWebhookEndpoints.appId, appId),
		isNull(developerWebhookEndpoints.deletedAt),
	);

export async function getWebhookEndpoint(
	appId: string,
	endpointId: string,
): Promise<WebhookEndpointRow | null> {
	const [endpoint] = await db()
		.select()
		.from(developerWebhookEndpoints)
		.where(liveEndpoint(appId, endpointId))
		.limit(1);
	return endpoint ?? null;
}

export async function listWebhookEndpoints(
	appId: string,
	page: { limit: number; offset: number },
): Promise<{ endpoints: WebhookEndpointRow[]; hasMore: boolean }> {
	const endpoints = await db()
		.select()
		.from(developerWebhookEndpoints)
		.where(
			and(
				eq(developerWebhookEndpoints.appId, appId),
				isNull(developerWebhookEndpoints.deletedAt),
			),
		)
		.orderBy(
			desc(developerWebhookEndpoints.createdAt),
			desc(developerWebhookEndpoints.id),
		)
		.limit(page.limit + 1)
		.offset(page.offset);
	return {
		endpoints: endpoints.slice(0, page.limit),
		hasMore: endpoints.length > page.limit,
	};
}

export async function createWebhookEndpoint(
	appId: string,
	input: { url: string; events?: WebhookEventType[]; enabled?: boolean },
	guards: Pick<WebhookGuards, "allowPrivate" | "isBlocked"> = {},
): Promise<
	{ ok: true; endpoint: WebhookEndpointRow; secret: string } | WebhookFailure
> {
	const problem = await checkWebhookUrl(input.url, guards);
	if (problem) return invalidUrl(problem);

	const id = nanoId();
	const secret = createWebhookSecret();
	const encryptedSecret = await encrypt(secret);

	const created = await db().transaction(async (tx) => {
		// The app row is the lock, so two requests at once cannot both pass the
		// count and leave the app over the limit.
		await tx
			.select({ id: developerApps.id })
			.from(developerApps)
			.where(eq(developerApps.id, appId))
			.for("update");
		const [existing] = await tx
			.select({ total: count() })
			.from(developerWebhookEndpoints)
			.where(
				and(
					eq(developerWebhookEndpoints.appId, appId),
					isNull(developerWebhookEndpoints.deletedAt),
				),
			);
		if ((existing?.total ?? 0) >= MAX_WEBHOOK_ENDPOINTS_PER_APP) return false;
		await tx.insert(developerWebhookEndpoints).values({
			id,
			appId,
			url: new URL(input.url).href,
			secretPrefix: secret.slice(0, SECRET_PREFIX_LENGTH),
			encryptedSecret,
			events: [...(input.events ?? WEBHOOK_EVENT_TYPES)],
			enabled: input.enabled ?? true,
		});
		return true;
	});
	if (!created) {
		return failure(
			409,
			"webhook_limit_reached",
			`An app can have ${MAX_WEBHOOK_ENDPOINTS_PER_APP} webhook endpoints`,
			"Delete an endpoint you no longer use, then create this one again.",
		);
	}

	const endpoint = await getWebhookEndpoint(appId, id);
	if (!endpoint) return notFound();
	return { ok: true, endpoint, secret };
}

export async function updateWebhookEndpoint(
	appId: string,
	endpointId: string,
	input: { url?: string; events?: WebhookEventType[]; enabled?: boolean },
	guards: Pick<WebhookGuards, "allowPrivate" | "isBlocked"> = {},
): Promise<{ ok: true; endpoint: WebhookEndpointRow } | WebhookFailure> {
	const current = await getWebhookEndpoint(appId, endpointId);
	if (!current) return notFound();

	if (input.url !== undefined) {
		const problem = await checkWebhookUrl(input.url, guards);
		if (problem) return invalidUrl(problem);
	}
	const url = input.url === undefined ? undefined : new URL(input.url).href;
	const restarts =
		input.enabled === true || (url !== undefined && url !== current.url);

	await db()
		.update(developerWebhookEndpoints)
		.set({
			...(url === undefined ? {} : { url }),
			...(input.events === undefined ? {} : { events: input.events }),
			...(input.enabled === undefined ? {} : { enabled: input.enabled }),
			...(input.enabled === true ? { disabledReason: null } : {}),
			...(restarts ? { consecutiveFailures: 0, failingSince: null } : {}),
		})
		.where(liveEndpoint(appId, endpointId));

	const endpoint = await getWebhookEndpoint(appId, endpointId);
	return endpoint ? { ok: true, endpoint } : notFound();
}

export async function deleteWebhookEndpoint(
	appId: string,
	endpointId: string,
): Promise<{ ok: true } | WebhookFailure> {
	const [endpoint] = await db()
		.select({ deletedAt: developerWebhookEndpoints.deletedAt })
		.from(developerWebhookEndpoints)
		.where(
			and(
				eq(developerWebhookEndpoints.id, endpointId),
				eq(developerWebhookEndpoints.appId, appId),
			),
		)
		.limit(1);
	if (!endpoint) return notFound();
	if (!endpoint.deletedAt) {
		await db()
			.update(developerWebhookEndpoints)
			.set({ deletedAt: new Date(), enabled: false })
			.where(liveEndpoint(appId, endpointId));
	}
	return { ok: true };
}

export function serializeWebhookTestResult(
	eventId: string,
	result: WebhookSendResult,
) {
	return {
		eventId,
		type: WEBHOOK_TEST_EVENT_TYPE,
		delivered: result.ok,
		responseStatus: result.responseStatus,
		errorCode: result.ok ? null : result.errorCode,
		durationMs: result.durationMs,
	};
}

// One attempt, sent while the caller waits and never retried. It records the
// last delivery but leaves the failure streak alone, so testing an endpoint
// that is not up yet cannot count towards disabling it.
export async function sendWebhookTestEvent(
	appId: string,
	endpointId: string,
	guards: WebhookGuards = {},
): Promise<
	{ ok: true; eventId: string; result: WebhookSendResult } | WebhookFailure
> {
	const endpoint = await getWebhookEndpoint(appId, endpointId);
	if (!endpoint) return notFound();

	const eventId = createWebhookTestEventId();
	const result = await sendDeveloperWebhook(
		{
			url: endpoint.url,
			secret: await decrypt(endpoint.encryptedSecret),
			eventId,
			eventType: WEBHOOK_TEST_EVENT_TYPE,
			body: JSON.stringify({
				id: eventId,
				type: WEBHOOK_TEST_EVENT_TYPE,
				createdAt: new Date().toISOString(),
				data: { webhookId: endpoint.id },
			}),
		},
		guards,
	);
	await recordWebhookDelivery(endpoint.id, result, {
		countsTowardStreak: false,
	});
	return { ok: true, eventId, result };
}
