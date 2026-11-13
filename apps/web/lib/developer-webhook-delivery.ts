import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import { developerApps, developerWebhookEndpoints } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
	WEBHOOK_DISABLE_AFTER_FAILURES,
	WEBHOOK_DISABLE_AFTER_MS,
	WEBHOOK_DISABLED_BY_FAILURES,
	WEBHOOK_TIMEOUT_MS,
	type WebhookDeliveryJob,
	type WebhookDeliveryOutcome,
} from "@/lib/developer-webhook-events";
import {
	signWebhookBody,
	WEBHOOK_EVENT_ID_HEADER,
	WEBHOOK_EVENT_TYPE_HEADER,
	WEBHOOK_SIGNATURE_HEADER,
} from "@/lib/developer-webhook-signature";
import { publicMediaUrlProblem } from "@/lib/public-media-fetch";
import { isBlockedS3Endpoint } from "@/lib/s3-endpoint-policy";
import { requestPublicOnly } from "@/lib/storage-fetch";

export type WebhookUrlProblem =
	| "invalid_url"
	| "https_required"
	| "credentials_in_url"
	| "unsupported_port"
	| "private_address";

export type WebhookErrorCode =
	| WebhookUrlProblem
	| "timeout"
	| "connection_failed"
	| "redirect"
	| "http_error";

export type WebhookSendResult =
	| { ok: true; responseStatus: number; durationMs: number }
	| {
			ok: false;
			responseStatus: number | null;
			errorCode: WebhookErrorCode;
			durationMs: number;
	  };

export type WebhookGuards = {
	allowPrivate?: boolean;
	isBlocked?: (url: string) => Promise<boolean>;
	request?: (url: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	now?: () => number;
};

// A receiver on localhost is how a webhook handler is written, so a local
// build may call plain http and private addresses. Every production build,
// Cap's own or a self-hosted one, only calls public https hosts.
export const allowsPrivateWebhookTargets = () => NODE_ENV !== "production";

const URL_PROBLEM_MESSAGES: Record<WebhookUrlProblem, string> = {
	invalid_url: "The URL is not valid",
	https_required: "The URL must start with https://",
	credentials_in_url: "The URL must not contain a username or password",
	unsupported_port: "The URL must use the default https port",
	private_address: "The URL must point to a public address",
};

// The stored URL is the parsed one, which is longer than what was sent when
// it holds characters that need encoding.
export const WEBHOOK_URL_MAX_LENGTH = 2_048;

export const webhookUrlProblemMessage = (problem: WebhookUrlProblem) =>
	URL_PROBLEM_MESSAGES[problem];

export function webhookUrlProblem(
	value: string,
	allowPrivate: boolean = allowsPrivateWebhookTargets(),
): WebhookUrlProblem | null {
	const problem = publicMediaUrlProblem(value);
	if (problem === "unsupported_scheme") return "https_required";
	if (problem === "invalid_url" || problem === "credentials_in_url") {
		return problem;
	}
	const url = new URL(value);
	if (url.href.length > WEBHOOK_URL_MAX_LENGTH) return "invalid_url";
	if (allowPrivate) return null;
	if (url.protocol !== "https:") return "https_required";
	return problem;
}

export async function checkWebhookUrl(
	value: string,
	guards: Pick<WebhookGuards, "allowPrivate" | "isBlocked"> = {},
): Promise<WebhookUrlProblem | null> {
	const allowPrivate = guards.allowPrivate ?? allowsPrivateWebhookTargets();
	const problem = webhookUrlProblem(value, allowPrivate);
	if (problem || allowPrivate) return problem;
	return (await (guards.isBlocked ?? isBlockedS3Endpoint)(value))
		? "private_address"
		: null;
}

const requestAnyAddress = (url: string, init: RequestInit) =>
	fetch(url, { ...init, redirect: "manual" });

const refusedPrivateAddress = (error: unknown) =>
	error instanceof Error && /private address/i.test(error.message);

export async function sendDeveloperWebhook(
	input: {
		url: string;
		secret: string;
		eventId: string;
		eventType: string;
		body: string;
	},
	guards: WebhookGuards = {},
): Promise<WebhookSendResult> {
	const now = guards.now ?? Date.now;
	const started = now();
	const failed = (
		errorCode: WebhookErrorCode,
		responseStatus: number | null = null,
	): WebhookSendResult => ({
		ok: false,
		responseStatus,
		errorCode,
		durationMs: now() - started,
	});

	const allowPrivate = guards.allowPrivate ?? allowsPrivateWebhookTargets();
	const request =
		guards.request ?? (allowPrivate ? requestAnyAddress : requestPublicOnly);
	const abort = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort.abort();
	}, guards.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
	const deadline = new Promise<never>((_, reject) => {
		abort.signal.addEventListener(
			"abort",
			() => reject(new Error("Webhook delivery timed out")),
			{ once: true },
		);
	});
	deadline.catch(() => {});

	try {
		// Resolving the host is part of the delivery, so it runs inside the
		// same deadline as the request.
		const check = checkWebhookUrl(input.url, {
			allowPrivate,
			isBlocked: guards.isBlocked,
		});
		check.catch(() => {});
		const problem = await Promise.race([check, deadline]);
		if (problem) return failed(problem);

		const response = await request(input.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "Cap-Webhooks/1.0",
				[WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(
					input.secret,
					input.body,
					Math.floor(now() / 1000),
				),
				[WEBHOOK_EVENT_ID_HEADER]: input.eventId,
				[WEBHOOK_EVENT_TYPE_HEADER]: input.eventType,
			},
			body: input.body,
			signal: abort.signal,
		});
		const { status } = response;
		await response.body?.cancel().catch(() => {});
		if (status >= 200 && status < 300) {
			return { ok: true, responseStatus: status, durationMs: now() - started };
		}
		return failed(
			status >= 300 && status < 400 ? "redirect" : "http_error",
			status,
		);
	} catch (error) {
		if (timedOut) return failed("timeout");
		return failed(
			refusedPrivateAddress(error) ? "private_address" : "connection_failed",
		);
	} finally {
		clearTimeout(timer);
		// Only the status is wanted. Closing the connection here means an
		// endpoint that keeps sending, or never finishes, holds nothing open.
		abort.abort();
	}
}

// The count, the start of the streak and the decision to disable are read and
// written under the endpoint's row lock, so a success and a failure recorded
// at the same moment cannot leave a streak start behind without its count.
export async function recordWebhookDelivery(
	endpointId: string,
	result: WebhookSendResult,
	options: { countsTowardStreak: boolean; now?: Date },
): Promise<void> {
	const now = options.now ?? new Date();
	await db().transaction(async (tx) => {
		const [endpoint] = await tx
			.select({
				enabled: developerWebhookEndpoints.enabled,
				consecutiveFailures: developerWebhookEndpoints.consecutiveFailures,
				failingSince: developerWebhookEndpoints.failingSince,
			})
			.from(developerWebhookEndpoints)
			.where(eq(developerWebhookEndpoints.id, endpointId))
			.for("update");
		if (!endpoint) return;

		const failures = endpoint.consecutiveFailures + 1;
		const failingSince = endpoint.failingSince ?? now;
		const disable =
			endpoint.enabled &&
			failures >= WEBHOOK_DISABLE_AFTER_FAILURES &&
			now.getTime() - failingSince.getTime() >= WEBHOOK_DISABLE_AFTER_MS;
		const streak = !options.countsTowardStreak
			? {}
			: result.ok
				? { consecutiveFailures: 0, failingSince: null }
				: {
						consecutiveFailures: failures,
						failingSince,
						...(disable
							? { enabled: false, disabledReason: WEBHOOK_DISABLED_BY_FAILURES }
							: {}),
					};

		await tx
			.update(developerWebhookEndpoints)
			.set({
				lastDeliveryAt: now,
				lastDeliveryStatus: result.ok ? "succeeded" : "failed",
				lastResponseStatus: result.responseStatus,
				lastErrorCode: result.ok ? null : result.errorCode,
				updatedAt: sql`${developerWebhookEndpoints.updatedAt}`,
				...streak,
			})
			.where(eq(developerWebhookEndpoints.id, endpointId));
	});
}

async function findDeliverableEndpoint(endpointId: string) {
	const [endpoint] = await db()
		.select({
			id: developerWebhookEndpoints.id,
			url: developerWebhookEndpoints.url,
			encryptedSecret: developerWebhookEndpoints.encryptedSecret,
			events: developerWebhookEndpoints.events,
			enabled: developerWebhookEndpoints.enabled,
		})
		.from(developerWebhookEndpoints)
		.innerJoin(
			developerApps,
			and(
				eq(developerWebhookEndpoints.appId, developerApps.id),
				isNull(developerApps.deletedAt),
			),
		)
		.where(
			and(
				eq(developerWebhookEndpoints.id, endpointId),
				isNull(developerWebhookEndpoints.deletedAt),
			),
		)
		.limit(1);
	return endpoint ?? null;
}

export async function deliverDeveloperWebhookAttempt(
	job: WebhookDeliveryJob,
	guards: WebhookGuards = {},
): Promise<WebhookDeliveryOutcome> {
	const endpoint = await findDeliverableEndpoint(job.endpointId);
	if (
		!endpoint ||
		!endpoint.enabled ||
		!endpoint.events.includes(job.eventType)
	) {
		return "dropped";
	}
	const result = await sendDeveloperWebhook(
		{
			url: endpoint.url,
			secret: await decrypt(endpoint.encryptedSecret),
			eventId: job.eventId,
			eventType: job.eventType,
			body: job.body,
		},
		guards,
	);
	await recordWebhookDelivery(endpoint.id, result, {
		countsTowardStreak: true,
	});
	return result.ok ? "delivered" : "retry";
}
