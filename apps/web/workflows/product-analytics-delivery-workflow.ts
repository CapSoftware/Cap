import {
	PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT,
	ProductAnalyticsError,
	type ProductEventRow,
	productAnalyticsIdentityHash,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import { db } from "@cap/database";
import {
	messengerSupportEmails,
	organizations,
	productAnalyticsIdentityState,
	productAnalyticsOutbox,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { FatalError } from "workflow";
import {
	acquireProductAnalyticsIngestionLease,
	deleteSuppressedProductAnalyticsOutboxRow,
	markProductAnalyticsOutboxDeadLetter,
	markProductAnalyticsOutboxDelivered,
	markProductAnalyticsOutboxRetrying,
	releaseProductAnalyticsIngestionLease,
} from "@/lib/analytics/product-event-outbox-state";

function isStoredProductEventRow(
	value: unknown,
	eventId: string,
): value is ProductEventRow {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		row.event_id === eventId &&
		typeof row.payload_hash === "string" &&
		/^[0-9a-f]{32}$/.test(row.payload_hash) &&
		typeof row.event_name === "string" &&
		typeof row.received_at === "string" &&
		typeof row.properties === "string"
	);
}

async function isProductAnalyticsIdentitySuppressed(row: ProductEventRow) {
	const identityHashes = [
		row.anonymous_id
			? productAnalyticsIdentityHash("anonymous", row.anonymous_id)
			: undefined,
		row.user_id ? productAnalyticsIdentityHash("user", row.user_id) : undefined,
		row.organization_id
			? productAnalyticsIdentityHash("organization", row.organization_id)
			: undefined,
	].filter((identityHash) => identityHash !== undefined);
	if (identityHashes.length > 0) {
		const [blocked] = await db()
			.select({ identityHash: productAnalyticsIdentityState.identityHash })
			.from(productAnalyticsIdentityState)
			.where(
				and(
					inArray(productAnalyticsIdentityState.identityHash, identityHashes),
					isNotNull(productAnalyticsIdentityState.blockedAt),
				),
			)
			.limit(1);
		if (blocked) return true;
	}
	if (row.synthetic_run_id) return false;
	const pendingDeletionUserIds = db()
		.select({ userId: messengerSupportEmails.userId })
		.from(messengerSupportEmails)
		.where(
			eq(
				messengerSupportEmails.subject,
				PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT,
			),
		);
	const [userRows, organizationRows] = await Promise.all([
		row.user_id
			? db()
					.select({ id: users.id })
					.from(users)
					.where(
						and(
							eq(users.id, User.UserId.make(row.user_id)),
							notInArray(users.id, pendingDeletionUserIds),
						),
					)
					.limit(1)
			: Promise.resolve([{}]),
		row.organization_id
			? db()
					.select({ id: organizations.id })
					.from(organizations)
					.where(
						and(
							eq(
								organizations.id,
								Organisation.OrganisationId.make(row.organization_id),
							),
							isNull(organizations.tombstoneAt),
						),
					)
					.limit(1)
			: Promise.resolve([{}]),
	]);
	return userRows.length === 0 || organizationRows.length === 0;
}

async function deliverProductAnalyticsRow(
	deliveryKey: string,
	row: ProductEventRow,
	lastErrorCode: string | null,
) {
	if (await isProductAnalyticsIdentitySuppressed(row)) {
		await deleteSuppressedProductAnalyticsOutboxRow(
			deliveryKey,
			row.payload_hash,
		);
		return { status: "suppressed" as const };
	}
	const env = serverEnv();
	const host = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
	const token = env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN;
	if (!host || !token) {
		await markProductAnalyticsOutboxDeadLetter(
			deliveryKey,
			row.payload_hash,
			"delivery_not_configured",
		);
		throw new FatalError("Product analytics delivery is not configured");
	}
	const stagingFault =
		env.VERCEL_ENV === "preview" &&
		row.synthetic_run_id.endsWith("_server") &&
		(row.event_id.startsWith("staging_") ||
			row.event_id.startsWith("stripe:staging_"));
	const retryFault = row.event_id.startsWith("staging_retry_429_")
		? {
				code: "staging_provider_429" as const,
				message: "Product analytics staging provider returned 429",
			}
		: row.event_id.startsWith("staging_retry_503_")
			? {
					code: "staging_provider_503" as const,
					message: "Product analytics staging provider returned 503",
				}
			: undefined;
	if (stagingFault && retryFault && lastErrorCode !== retryFault.code) {
		await markProductAnalyticsOutboxRetrying(
			deliveryKey,
			row.payload_hash,
			retryFault.code,
		);
		throw new Error(retryFault.message);
	}
	if (stagingFault && row.event_id.startsWith("staging_reject_400_")) {
		await markProductAnalyticsOutboxDeadLetter(
			deliveryKey,
			row.payload_hash,
			"provider_rejected",
		);
		throw new FatalError("Product analytics staging provider returned 400");
	}
	const ingestionLeaseId = await acquireProductAnalyticsIngestionLease();
	if (!ingestionLeaseId) {
		await markProductAnalyticsOutboxRetrying(deliveryKey, row.payload_hash);
		throw new Error("Product analytics erasure is in progress");
	}

	try {
		await sendProductAnalyticsRows({
			host,
			token,
			rows: [row],
			wait: true,
			maxAttempts: 1,
		});
	} catch (error) {
		if (error instanceof ProductAnalyticsError && !error.retryable) {
			await markProductAnalyticsOutboxDeadLetter(
				deliveryKey,
				row.payload_hash,
				"provider_rejected",
			);
			throw new FatalError(
				`Product analytics permanently rejected event with status ${error.status ?? "unknown"}`,
			);
		}
		await markProductAnalyticsOutboxRetrying(deliveryKey, row.payload_hash);
		throw new Error("Product analytics delivery temporarily failed");
	} finally {
		await releaseProductAnalyticsIngestionLease(ingestionLeaseId);
	}
	if (
		stagingFault &&
		row.event_name === "purchase_completed" &&
		row.event_id.startsWith("stripe:staging_ambiguous_") &&
		row.event_id.endsWith(":purchase_completed") &&
		lastErrorCode !== "staging_timeout_after_accept"
	) {
		await markProductAnalyticsOutboxRetrying(
			deliveryKey,
			row.payload_hash,
			"staging_timeout_after_accept",
		);
		throw new Error("Product analytics staging delivery acknowledgement lost");
	}
	await markProductAnalyticsOutboxDelivered(deliveryKey, row.payload_hash);
	return { status: "delivered" as const };
}

export async function deliverProductAnalyticsRowStep(deliveryKey: string) {
	"use step";
	const [stored] = await db()
		.select({
			eventId: productAnalyticsOutbox.eventId,
			payload: productAnalyticsOutbox.payload,
			payloadHash: productAnalyticsOutbox.payloadHash,
			payloadKind: productAnalyticsOutbox.payloadKind,
			lastErrorCode: productAnalyticsOutbox.lastErrorCode,
		})
		.from(productAnalyticsOutbox)
		.where(eq(productAnalyticsOutbox.deliveryKey, deliveryKey))
		.limit(1);
	if (!stored) return { status: "discarded" as const };
	if (
		stored.payloadKind !== "product_event_row_v1" ||
		!isStoredProductEventRow(stored.payload, stored.eventId)
	) {
		await markProductAnalyticsOutboxDeadLetter(
			deliveryKey,
			stored.payloadHash,
			"contract_invalid",
		);
		throw new FatalError("Stored product analytics event is invalid");
	}
	return deliverProductAnalyticsRow(
		deliveryKey,
		stored.payload,
		stored.lastErrorCode,
	);
}
deliverProductAnalyticsRowStep.maxRetries = 8;

export async function deliverProductAnalyticsRowWorkflow(deliveryKey: string) {
	"use workflow";
	return deliverProductAnalyticsRowStep(deliveryKey);
}
