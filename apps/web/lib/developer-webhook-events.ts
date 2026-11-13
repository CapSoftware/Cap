export const WEBHOOK_EVENT_TYPES = ["video.ready", "video.errored"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_TEST_EVENT_TYPE = "webhook.test";

export const MAX_WEBHOOK_ENDPOINTS_PER_APP = 5;
export const WEBHOOK_TIMEOUT_MS = 10_000;

// Eight attempts in all: the first straight away, then one after each of
// these gaps, which add up to 23 hours 36 minutes.
export const WEBHOOK_RETRY_DELAYS_SECONDS = [
	60,
	5 * 60,
	30 * 60,
	2 * 60 * 60,
	5 * 60 * 60,
	8 * 60 * 60,
	8 * 60 * 60,
] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;

export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
export const WEBHOOK_DISABLE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;
export const WEBHOOK_DISABLED_BY_FAILURES = "delivery_failures";

export type WebhookDeliveryOutcome = "delivered" | "retry" | "dropped";

export interface WebhookDeliveryJob {
	endpointId: string;
	eventId: string;
	eventType: string;
	body: string;
}

export function webhookRetryDelaySeconds(attempt: number): number | null {
	return WEBHOOK_RETRY_DELAYS_SECONDS[attempt - 1] ?? null;
}

export function isWebhookEventType(value: string): value is WebhookEventType {
	return WEBHOOK_EVENT_TYPES.some((type) => type === value);
}

export function developerVideoEventType(
	previous: string,
	next: string | undefined,
): WebhookEventType | null {
	if (next === undefined || next === previous) return null;
	if (next === "ready") return "video.ready";
	if (next === "errored") return "video.errored";
	return null;
}
