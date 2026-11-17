import type {
	DeveloperVideoPartState,
	DeveloperVideoProcessingState,
} from "@cap/database/types";
import { DEVELOPER_VIDEO_PARTS } from "@/lib/developer-video-state";

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

// video.ready waits for every output so it carries every playback URL. An
// output still encoding this long after the video became ready is treated as
// stuck, and the event goes out with the URLs that exist.
export const READY_EVENT_MAX_WAIT_MS = 30 * 60 * 1000;

const SETTLED_PART_STATES: ReadonlySet<DeveloperVideoPartState["state"]> =
	new Set(["complete", "failed", "unavailable"]);

interface EventVideo {
	status: string;
	processing: DeveloperVideoProcessingState | null;
}

export interface DeveloperVideoEventStep {
	type: WebhookEventType | null;
	processing?: DeveloperVideoProcessingState;
}

export function developerVideoOutputsSettled(
	processing: DeveloperVideoProcessingState,
): boolean {
	return DEVELOPER_VIDEO_PARTS.every((part) =>
		SETTLED_PART_STATES.has(processing[part].state),
	);
}

// Due once every output has settled or the wait has run out. Also true for a
// marked video whose last output was settled by a write that did not send,
// such as one from the previous deployment while this one rolls out.
export function developerVideoReadyEventDue(
	video: EventVideo,
	now: number,
): boolean {
	const processing = video.processing;
	const dueAt = processing?.readyEventDueAt;
	if (video.status !== "ready" || !processing || dueAt == null) return false;
	return (
		developerVideoOutputsSettled(processing) ||
		now - dueAt >= READY_EVENT_MAX_WAIT_MS
	);
}

// Runs inside the transaction that writes `next`, under the video's row lock,
// so concurrent writers see each other's marker and only one of them sends.
export function developerVideoEventStep(
	previous: EventVideo,
	next: EventVideo,
	now: number,
): DeveloperVideoEventStep {
	const processing = next.processing;
	if (next.status !== previous.status) {
		if (next.status === "errored") return { type: "video.errored" };
		if (next.status !== "ready") return { type: null };
		if (!processing || developerVideoOutputsSettled(processing)) {
			return { type: "video.ready" };
		}
		return { type: null, processing: { ...processing, readyEventDueAt: now } };
	}
	if (!processing || !developerVideoReadyEventDue(next, now)) {
		return { type: null };
	}
	const { readyEventDueAt: _readyEventDueAt, ...announced } = processing;
	return { type: "video.ready", processing: announced };
}
