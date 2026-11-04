import { db } from "@cap/database";
import { s3Buckets } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { User } from "@cap/web-domain";
import { and, count, eq, gt } from "drizzle-orm";
import { isMediaProcessingSuspended } from "@/lib/media-processing-policy";
import {
	blockedS3EndpointMessage,
	isDisallowedCustomStorageEndpoint,
	shouldBlockPrivateS3Endpoints,
} from "@/lib/s3-endpoint-policy";

export const CUSTOM_STORAGE_SAVE_LIMIT = 5;
export const CUSTOM_STORAGE_SAVE_WINDOW_MS = 60 * 60 * 1000;

export const customStorageProRequiredMessage =
	"Cap Pro is required to use custom storage";
export const customStorageHttpsRequiredMessage =
	"Custom storage endpoints must use https://";
export const customStorageRateLimitMessage =
	"Too many storage configuration changes. Try again later.";
export const customStorageUnavailableMessage =
	"Custom storage is unavailable for this account";

export type CustomStorageSaveRejection = {
	reason:
		| "pro_required"
		| "endpoint_not_allowed"
		| "https_required"
		| "unavailable"
		| "rate_limited";
	message: string;
	status: 400 | 403 | 429;
};

export function isInsecureS3Endpoint(
	endpoint: string,
	requireHttps = shouldBlockPrivateS3Endpoints(),
) {
	const trimmed = endpoint.trim();
	if (!requireHttps || !trimmed) return false;
	try {
		return new URL(trimmed).protocol !== "https:";
	} catch {
		return true;
	}
}

export async function countRecentCustomStorageSaves(
	ownerId: User.UserId,
	now = new Date(),
) {
	const [row] = await db()
		.select({ value: count() })
		.from(s3Buckets)
		.where(
			and(
				eq(s3Buckets.ownerId, ownerId),
				gt(
					s3Buckets.createdAt,
					new Date(now.getTime() - CUSTOM_STORAGE_SAVE_WINDOW_MS),
				),
			),
		);
	return Number(row?.value ?? 0);
}

export async function getCustomStorageSaveRejection(input: {
	user: {
		id: User.UserId;
		stripeSubscriptionStatus?: string | null;
		thirdPartyStripeSubscriptionId?: string | null;
	};
	endpoint: string;
	checkPro?: boolean;
	now?: Date;
}): Promise<CustomStorageSaveRejection | null> {
	if (input.checkPro !== false && !userIsPro(input.user)) {
		return {
			reason: "pro_required",
			message: customStorageProRequiredMessage,
			status: 403,
		};
	}
	if (isDisallowedCustomStorageEndpoint(input.endpoint)) {
		return {
			reason: "endpoint_not_allowed",
			message: blockedS3EndpointMessage,
			status: 400,
		};
	}
	if (isInsecureS3Endpoint(input.endpoint)) {
		return {
			reason: "https_required",
			message: customStorageHttpsRequiredMessage,
			status: 400,
		};
	}
	if (await isMediaProcessingSuspended(input.user.id)) {
		return {
			reason: "unavailable",
			message: customStorageUnavailableMessage,
			status: 403,
		};
	}
	if (
		(await countRecentCustomStorageSaves(input.user.id, input.now)) >=
		CUSTOM_STORAGE_SAVE_LIMIT
	) {
		return {
			reason: "rate_limited",
			message: customStorageRateLimitMessage,
			status: 429,
		};
	}
	return null;
}

export type CustomStorageAttemptAction =
	| "save_personal"
	| "test_personal"
	| "save_organization"
	| "test_organization";

export function getEndpointHostForLog(endpoint: string) {
	const trimmed = endpoint.trim();
	if (!trimmed) return "default";
	try {
		return new URL(trimmed).hostname || "invalid";
	} catch {
		return "invalid";
	}
}

export function logCustomStorageAttempt(input: {
	userId: User.UserId;
	action: CustomStorageAttemptAction;
	organizationId?: string | null;
	rejection: string | null;
	endpoint: string;
	clientIp: string | null;
}) {
	console.warn("[custom-storage] config attempt", {
		userId: input.userId,
		action: input.action,
		organizationId: input.organizationId ?? null,
		outcome: input.rejection ? "rejected" : "allowed",
		reason: input.rejection,
		endpointHost: getEndpointHostForLog(input.endpoint),
		clientIp: input.clientIp,
	});
}
