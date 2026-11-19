import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { nanoId, nanoIdLong } from "@cap/database/helpers";
import type { WebhookEventType } from "@/lib/developer-webhook-events";

export const WEBHOOK_SECRET_PREFIX = "cws_";
export const WEBHOOK_SIGNATURE_HEADER = "Cap-Signature";
export const WEBHOOK_EVENT_ID_HEADER = "Cap-Event-Id";
export const WEBHOOK_EVENT_TYPE_HEADER = "Cap-Event-Type";
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const EVENT_ID_PREFIX = "evt_";

export const createWebhookSecret = () =>
	`${WEBHOOK_SECRET_PREFIX}${nanoIdLong()}`;

export const createWebhookTestEventId = () =>
	`${EVENT_ID_PREFIX}test_${nanoId()}`;

// A video reaches each of these states once, so the same video and type
// always name the same event. A repeated send carries the id the receiver
// has already seen.
export function developerVideoEventId(
	videoId: string,
	type: WebhookEventType,
): string {
	const digest = createHash("sha256")
		.update(`${type}:${videoId}`)
		.digest("hex");
	return `${EVENT_ID_PREFIX}${digest.slice(0, 24)}`;
}

function signature(secret: string, timestamp: number, body: string): string {
	return createHmac("sha256", secret)
		.update(`${timestamp}.${body}`)
		.digest("hex");
}

export function signWebhookBody(
	secret: string,
	body: string,
	timestamp: number,
): string {
	return `t=${timestamp},v1=${signature(secret, timestamp, body)}`;
}

export function verifyWebhookSignature(input: {
	secret: string;
	body: string;
	header: string | null | undefined;
	now?: number;
	toleranceSeconds?: number;
}): boolean {
	if (!input.header) return false;
	const fields = new Map(
		input.header.split(",").map((part) => {
			const [name, ...rest] = part.split("=");
			return [name?.trim() ?? "", rest.join("=").trim()] as const;
		}),
	);
	const rawTimestamp = fields.get("t") ?? "";
	const supplied = fields.get("v1") ?? "";
	if (!/^\d{1,12}$/.test(rawTimestamp) || !/^[0-9a-f]{64}$/.test(supplied)) {
		return false;
	}
	const timestamp = Number(rawTimestamp);
	const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
	const tolerance =
		input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
	if (Math.abs(nowSeconds - timestamp) > tolerance) return false;
	return timingSafeEqual(
		Buffer.from(supplied, "hex"),
		Buffer.from(signature(input.secret, timestamp, input.body), "hex"),
	);
}
