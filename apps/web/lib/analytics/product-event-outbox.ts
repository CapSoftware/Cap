import { randomUUID } from "node:crypto";
import {
	type ProductEventRow,
	productAnalyticsEventIdHash,
	productAnalyticsIdentityHash,
} from "@cap/analytics";
import { db } from "@cap/database";
import {
	productAnalyticsEventReceipts,
	productAnalyticsIdentityLinks,
	productAnalyticsIdentityState,
	productAnalyticsIngestionLeases,
	productAnalyticsOutbox,
	productAnalyticsReconciliationFailures,
} from "@cap/database/schema";
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { start } from "workflow/api";
import { deliverProductAnalyticsRowWorkflow } from "@/workflows/product-analytics-delivery-workflow";
import {
	createServerProductEventRows,
	type ServerProductEvent,
} from "./server-event";

type DatabaseClient = ReturnType<typeof db>;
export type ProductAnalyticsOutboxTransaction = Parameters<
	Parameters<DatabaseClient["transaction"]>[0]
>[0];

const MAX_DRAIN_BATCH_SIZE = 500;
const DRAIN_CONCURRENCY = 10;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const MAX_OUTBOX_PAYLOAD_BYTES = 16 * 1_024;
const OUTBOX_LEASE_DURATION_MS = 2 * 60 * 1_000;
const DELIVERY_CONFIRMATION_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const DELIVERED_RETENTION_MS = 31 * 24 * 60 * 60 * 1_000;
const OLDEST_PENDING_SLO_MS = 15 * 60 * 1_000;
const EVENT_RECEIPT_RETENTION_MS = 800 * 24 * 60 * 60 * 1_000;
const CLEANUP_BATCH_SIZE = 1_000;

const eventIdentityStates = (row: ProductEventRow) => {
	return [
		row.anonymous_id
			? {
					identityHash: productAnalyticsIdentityHash(
						"anonymous",
						row.anonymous_id,
					),
					identityKind: "anonymous" as const,
				}
			: undefined,
		row.user_id
			? {
					identityHash: productAnalyticsIdentityHash("user", row.user_id),
					identityKind: "user" as const,
				}
			: undefined,
		row.organization_id
			? {
					identityHash: productAnalyticsIdentityHash(
						"organization",
						row.organization_id,
					),
					identityKind: "organization" as const,
				}
			: undefined,
	]
		.filter((entry) => entry !== undefined)
		.sort((left, right) => left.identityHash.localeCompare(right.identityHash));
};

function validatedEvent(event: ServerProductEvent) {
	const [row] = createServerProductEventRows(event);
	if (!row) {
		throw new Error("Product analytics event failed contract validation");
	}
	return row;
}

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

export async function persistProductAnalyticsEvent(
	tx: ProductAnalyticsOutboxTransaction,
	event: ServerProductEvent,
) {
	const row = validatedEvent(event);
	const payloadBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
	if (payloadBytes > MAX_OUTBOX_PAYLOAD_BYTES) {
		throw new Error("Product analytics outbox payload exceeds its bound");
	}
	const identities = eventIdentityStates(row);
	if (identities.length > 0) {
		await tx
			.insert(productAnalyticsIdentityState)
			.values(identities)
			.onDuplicateKeyUpdate({
				set: {
					identityHash: sql`${productAnalyticsIdentityState.identityHash}`,
				},
			});
		const blocked = await tx
			.select({
				blockedAt: productAnalyticsIdentityState.blockedAt,
				identityKind: productAnalyticsIdentityState.identityKind,
			})
			.from(productAnalyticsIdentityState)
			.where(
				inArray(
					productAnalyticsIdentityState.identityHash,
					identities.map((identity) => identity.identityHash),
				),
			)
			.for("update");
		const blockedAt = blocked.find(
			(identity) => identity.blockedAt !== null,
		)?.blockedAt;
		if (blockedAt) {
			const blockedPrincipal = blocked.some(
				(identity) =>
					identity.blockedAt !== null && identity.identityKind !== "anonymous",
			);
			const anonymousHashes = identities
				.filter((identity) => identity.identityKind === "anonymous")
				.map((identity) => identity.identityHash);
			if (blockedPrincipal && anonymousHashes.length > 0) {
				await tx
					.update(productAnalyticsIdentityState)
					.set({ blockedAt })
					.where(
						inArray(
							productAnalyticsIdentityState.identityHash,
							anonymousHashes,
						),
					);
			}
			return {
				eventId: row.event_id,
				payloadHash: row.payload_hash,
				payloadConflict: false,
				status: "suppressed" as const,
				suppressed: true as const,
			};
		}
		const anonymousIdentity = identities.find(
			(identity) => identity.identityKind === "anonymous",
		);
		const userIdentity = identities.find(
			(identity) => identity.identityKind === "user",
		);
		const organizationIdentity = identities.find(
			(identity) => identity.identityKind === "organization",
		);
		if (anonymousIdentity && userIdentity && row.anonymous_id) {
			await tx
				.insert(productAnalyticsIdentityLinks)
				.values({
					anonymousIdentityHash: anonymousIdentity.identityHash,
					userIdentityHash: userIdentity.identityHash,
					organizationIdentityHash: organizationIdentity?.identityHash ?? null,
					anonymousId: row.anonymous_id,
				})
				.onDuplicateKeyUpdate({
					set: {
						organizationIdentityHash:
							organizationIdentity?.identityHash ?? null,
						updatedAt: new Date(),
					},
				});
		}
	}
	const eventIdHash = productAnalyticsEventIdHash(row.event_id);
	const identityHashes = Object.fromEntries(
		identities.map((identity) => [
			identity.identityKind,
			identity.identityHash,
		]),
	) as Partial<Record<"anonymous" | "organization" | "user", string>>;
	const now = new Date();
	const retainUntil = new Date(now.getTime() + EVENT_RECEIPT_RETENTION_MS);
	await tx
		.insert(productAnalyticsEventReceipts)
		.values({
			eventIdHash,
			payloadHash: row.payload_hash,
			anonymousIdentityHash: identityHashes.anonymous ?? null,
			userIdentityHash: identityHashes.user ?? null,
			organizationIdentityHash: identityHashes.organization ?? null,
			retainUntil,
		})
		.onDuplicateKeyUpdate({
			set: {
				conflictCount: sql`IF(${productAnalyticsEventReceipts.payloadHash} <> ${row.payload_hash}, ${productAnalyticsEventReceipts.conflictCount} + 1, ${productAnalyticsEventReceipts.conflictCount})`,
				lastSeenAt: now,
				retainUntil: sql`GREATEST(${productAnalyticsEventReceipts.retainUntil}, ${retainUntil})`,
			},
		});
	const [receipt] = await tx
		.select({ payloadHash: productAnalyticsEventReceipts.payloadHash })
		.from(productAnalyticsEventReceipts)
		.where(eq(productAnalyticsEventReceipts.eventIdHash, eventIdHash))
		.limit(1)
		.for("update");
	if (!receipt || receipt.payloadHash !== row.payload_hash) {
		return {
			eventId: row.event_id,
			payloadHash: row.payload_hash,
			payloadConflict: true,
			status: "conflict" as const,
		};
	}
	const deliveryKey = randomUUID();
	await tx
		.insert(productAnalyticsOutbox)
		.values({
			eventId: row.event_id,
			deliveryKey,
			payloadHash: row.payload_hash,
			eventName: row.event_name,
			payloadKind: "product_event_row_v1",
			payload: row,
			anonymousId: row.anonymous_id || null,
			userId: row.user_id || null,
			organizationId: row.organization_id || null,
		})
		.onDuplicateKeyUpdate({
			set: {
				payloadConflict: sql`IF(${productAnalyticsOutbox.payloadHash} <> ${row.payload_hash}, TRUE, ${productAnalyticsOutbox.payloadConflict})`,
				status: sql`IF(${productAnalyticsOutbox.payloadHash} = ${row.payload_hash} AND ${productAnalyticsOutbox.deadLetteredAt} IS NOT NULL, 'pending', ${productAnalyticsOutbox.status})`,
				nextAttemptAt: sql`IF(${productAnalyticsOutbox.payloadHash} = ${row.payload_hash} AND ${productAnalyticsOutbox.deadLetteredAt} IS NOT NULL, CURRENT_TIMESTAMP, ${productAnalyticsOutbox.nextAttemptAt})`,
				leaseOwnerId: sql`IF(${productAnalyticsOutbox.payloadHash} = ${row.payload_hash} AND ${productAnalyticsOutbox.deadLetteredAt} IS NOT NULL, NULL, ${productAnalyticsOutbox.leaseOwnerId})`,
				leaseExpiresAt: sql`IF(${productAnalyticsOutbox.payloadHash} = ${row.payload_hash} AND ${productAnalyticsOutbox.deadLetteredAt} IS NOT NULL, NULL, ${productAnalyticsOutbox.leaseExpiresAt})`,
				lastErrorCode: sql`IF(${productAnalyticsOutbox.payloadHash} <> ${row.payload_hash}, 'payload_conflict', IF(${productAnalyticsOutbox.deadLetteredAt} IS NOT NULL, NULL, ${productAnalyticsOutbox.lastErrorCode}))`,
				deadLetteredAt: sql`IF(${productAnalyticsOutbox.payloadHash} = ${row.payload_hash}, NULL, ${productAnalyticsOutbox.deadLetteredAt})`,
				updatedAt: new Date(),
			},
		});
	const [stored] = await tx
		.select({
			deliveryKey: productAnalyticsOutbox.deliveryKey,
			payloadHash: productAnalyticsOutbox.payloadHash,
			status: productAnalyticsOutbox.status,
		})
		.from(productAnalyticsOutbox)
		.where(eq(productAnalyticsOutbox.eventId, row.event_id))
		.limit(1);
	return {
		eventId: row.event_id,
		deliveryKey: stored?.deliveryKey ?? deliveryKey,
		payloadHash: row.payload_hash,
		payloadConflict: stored?.payloadHash !== row.payload_hash,
		status: stored?.status,
	};
}

export async function queueDurableServerProductEvent(
	event: ServerProductEvent,
) {
	const persisted = await db().transaction((tx) =>
		persistProductAnalyticsEvent(tx, event),
	);
	if (persisted.status === "suppressed" || persisted.status === "conflict") {
		return persisted;
	}
	const delivery = await attemptProductAnalyticsOutboxDelivery(
		persisted.eventId,
	);
	return { ...persisted, ...delivery };
}

async function claimPendingProductAnalyticsEvent(eventId: string) {
	const leaseOwnerId = randomUUID();
	const now = new Date();
	await db()
		.update(productAnalyticsOutbox)
		.set({
			leaseOwnerId,
			leaseExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_DURATION_MS),
		})
		.where(
			and(
				eq(productAnalyticsOutbox.eventId, eventId),
				eq(productAnalyticsOutbox.status, "pending"),
				lte(productAnalyticsOutbox.nextAttemptAt, now),
				or(
					isNull(productAnalyticsOutbox.leaseOwnerId),
					isNull(productAnalyticsOutbox.leaseExpiresAt),
					lt(productAnalyticsOutbox.leaseExpiresAt, now),
				),
			),
		);
	const [claimed] = await db()
		.select({
			deliveryKey: productAnalyticsOutbox.deliveryKey,
			payload: productAnalyticsOutbox.payload,
			payloadKind: productAnalyticsOutbox.payloadKind,
			payloadConflict: productAnalyticsOutbox.payloadConflict,
		})
		.from(productAnalyticsOutbox)
		.where(
			and(
				eq(productAnalyticsOutbox.eventId, eventId),
				eq(productAnalyticsOutbox.leaseOwnerId, leaseOwnerId),
			),
		)
		.limit(1);
	return claimed ? { ...claimed, leaseOwnerId } : undefined;
}

async function startPendingProductAnalyticsEvent(eventId: string) {
	const pending = await claimPendingProductAnalyticsEvent(eventId);
	if (!pending) return { status: "unavailable" as const };

	if (
		pending.payloadKind !== "product_event_row_v1" ||
		!isStoredProductEventRow(pending.payload, eventId)
	) {
		await db()
			.update(productAnalyticsOutbox)
			.set({
				status: "dead_letter",
				lastErrorCode: "stored_contract_invalid",
				deadLetteredAt: new Date(),
				leaseOwnerId: null,
				leaseExpiresAt: null,
			})
			.where(
				and(
					eq(productAnalyticsOutbox.eventId, eventId),
					eq(productAnalyticsOutbox.leaseOwnerId, pending.leaseOwnerId),
				),
			);
		return { status: "dead_lettered" as const };
	}

	try {
		const run = await start(deliverProductAnalyticsRowWorkflow, [
			pending.deliveryKey,
		]);
		await db()
			.update(productAnalyticsOutbox)
			.set({
				status: "workflow_started",
				attemptCount: sql`${productAnalyticsOutbox.attemptCount} + 1`,
				nextAttemptAt: new Date(Date.now() + DELIVERY_CONFIRMATION_TIMEOUT_MS),
				workflowRunId: run.runId,
				lastErrorCode: pending.payloadConflict ? "payload_conflict" : null,
				leaseOwnerId: null,
				leaseExpiresAt: null,
			})
			.where(
				and(
					eq(productAnalyticsOutbox.eventId, eventId),
					eq(productAnalyticsOutbox.status, "pending"),
					eq(productAnalyticsOutbox.leaseOwnerId, pending.leaseOwnerId),
				),
			);
		return { status: "started" as const, runId: run.runId };
	} catch (error) {
		const [row] = await db()
			.select({ attemptCount: productAnalyticsOutbox.attemptCount })
			.from(productAnalyticsOutbox)
			.where(
				and(
					eq(productAnalyticsOutbox.eventId, eventId),
					eq(productAnalyticsOutbox.leaseOwnerId, pending.leaseOwnerId),
				),
			)
			.limit(1);
		if (row) {
			const attemptCount = row.attemptCount + 1;
			const retryDelay = Math.min(
				MAX_RETRY_DELAY_MS,
				2 ** Math.min(attemptCount, 10) * 1_000,
			);
			await db()
				.update(productAnalyticsOutbox)
				.set({
					attemptCount,
					nextAttemptAt: new Date(Date.now() + retryDelay),
					lastErrorCode: "workflow_start_failed",
					leaseOwnerId: null,
					leaseExpiresAt: null,
				})
				.where(
					and(
						eq(productAnalyticsOutbox.eventId, eventId),
						eq(productAnalyticsOutbox.leaseOwnerId, pending.leaseOwnerId),
					),
				);
		}
		throw error;
	}
}

export async function attemptProductAnalyticsOutboxDelivery(eventId: string) {
	try {
		return await startPendingProductAnalyticsEvent(eventId);
	} catch {
		console.error("Product analytics outbox delivery deferred");
		return { status: "deferred" as const };
	}
}

export async function drainProductAnalyticsOutbox(
	limit = MAX_DRAIN_BATCH_SIZE,
) {
	const boundedLimit = Math.max(1, Math.min(limit, MAX_DRAIN_BATCH_SIZE));
	const now = new Date();
	await db()
		.update(productAnalyticsOutbox)
		.set({
			status: "pending",
			workflowRunId: null,
			lastErrorCode: "delivery_unconfirmed",
			leaseOwnerId: null,
			leaseExpiresAt: null,
			nextAttemptAt: now,
		})
		.where(
			and(
				eq(productAnalyticsOutbox.status, "workflow_started"),
				lte(productAnalyticsOutbox.nextAttemptAt, now),
			),
		);
	const expiredDelivered = await db()
		.select({ eventId: productAnalyticsOutbox.eventId })
		.from(productAnalyticsOutbox)
		.where(
			and(
				eq(productAnalyticsOutbox.status, "delivered"),
				isNotNull(productAnalyticsOutbox.deliveredAt),
				lt(
					productAnalyticsOutbox.deliveredAt,
					new Date(now.getTime() - DELIVERED_RETENTION_MS),
				),
			),
		)
		.orderBy(asc(productAnalyticsOutbox.deliveredAt))
		.limit(CLEANUP_BATCH_SIZE);
	if (expiredDelivered.length > 0) {
		await db()
			.delete(productAnalyticsOutbox)
			.where(
				inArray(
					productAnalyticsOutbox.eventId,
					expiredDelivered.map((row) => row.eventId),
				),
			);
	}
	const expiredReceipts = await db()
		.select({ eventIdHash: productAnalyticsEventReceipts.eventIdHash })
		.from(productAnalyticsEventReceipts)
		.where(lt(productAnalyticsEventReceipts.retainUntil, now))
		.orderBy(asc(productAnalyticsEventReceipts.retainUntil))
		.limit(CLEANUP_BATCH_SIZE);
	if (expiredReceipts.length > 0) {
		await db()
			.delete(productAnalyticsEventReceipts)
			.where(
				inArray(
					productAnalyticsEventReceipts.eventIdHash,
					expiredReceipts.map((row) => row.eventIdHash),
				),
			);
	}
	const expiredLeases = await db()
		.select({ id: productAnalyticsIngestionLeases.id })
		.from(productAnalyticsIngestionLeases)
		.where(lt(productAnalyticsIngestionLeases.expiresAt, now))
		.orderBy(asc(productAnalyticsIngestionLeases.expiresAt))
		.limit(CLEANUP_BATCH_SIZE);
	if (expiredLeases.length > 0) {
		await db()
			.delete(productAnalyticsIngestionLeases)
			.where(
				inArray(
					productAnalyticsIngestionLeases.id,
					expiredLeases.map((row) => row.id),
				),
			);
	}
	const pending = await db()
		.select({ eventId: productAnalyticsOutbox.eventId })
		.from(productAnalyticsOutbox)
		.where(
			and(
				eq(productAnalyticsOutbox.status, "pending"),
				lte(productAnalyticsOutbox.nextAttemptAt, new Date()),
				or(
					isNull(productAnalyticsOutbox.leaseOwnerId),
					isNull(productAnalyticsOutbox.leaseExpiresAt),
					lt(productAnalyticsOutbox.leaseExpiresAt, new Date()),
				),
			),
		)
		.orderBy(asc(productAnalyticsOutbox.createdAt))
		.limit(boundedLimit);

	const results: Awaited<
		ReturnType<typeof attemptProductAnalyticsOutboxDelivery>
	>[] = [];
	for (let offset = 0; offset < pending.length; offset += DRAIN_CONCURRENCY) {
		const batch = pending.slice(offset, offset + DRAIN_CONCURRENCY);
		results.push(
			...(await Promise.all(
				batch.map((row) => attemptProductAnalyticsOutboxDelivery(row.eventId)),
			)),
		);
	}
	const started = results.filter(
		(result) => result.status === "started",
	).length;
	const deferred = results.filter(
		(result) => result.status === "deferred",
	).length;
	const deadLettered = results.filter(
		(result) => result.status === "dead_lettered",
	).length;
	return {
		attempted: pending.length,
		started,
		deferred,
		deadLettered,
		cleanedDelivered: expiredDelivered.length,
		cleanedReceipts: expiredReceipts.length,
		cleanedLeases: expiredLeases.length,
		capacityPerDay: MAX_DRAIN_BATCH_SIZE * 12 * 24,
	};
}

export async function getProductAnalyticsOutboxHealth() {
	const now = new Date();
	const [rows, [receiptConflicts], reconciliationFailures] = await Promise.all([
		db()
			.select({
				eventName: productAnalyticsOutbox.eventName,
				pending: sql<number>`SUM(IF(${productAnalyticsOutbox.status} = 'pending', 1, 0))`,
				due: sql<number>`SUM(IF(${productAnalyticsOutbox.status} = 'pending' AND ${productAnalyticsOutbox.nextAttemptAt} <= ${now}, 1, 0))`,
				leased: sql<number>`SUM(IF(${productAnalyticsOutbox.status} = 'pending' AND ${productAnalyticsOutbox.leaseExpiresAt} > ${now}, 1, 0))`,
				deadLetter: sql<number>`SUM(IF(${productAnalyticsOutbox.status} = 'dead_letter', 1, 0))`,
				payloadConflict: sql<number>`SUM(IF(${productAnalyticsOutbox.payloadConflict}, 1, 0))`,
				workflowStarted: sql<number>`SUM(IF(${productAnalyticsOutbox.status} = 'workflow_started', 1, 0))`,
				oldestActiveAt: sql<
					Date | string | null
				>`MIN(${productAnalyticsOutbox.createdAt})`,
				oldestDeadLetterAt: sql<
					Date | string | null
				>`MIN(IF(${productAnalyticsOutbox.status} = 'dead_letter', ${productAnalyticsOutbox.deadLetteredAt}, NULL))`,
			})
			.from(productAnalyticsOutbox)
			.where(
				inArray(productAnalyticsOutbox.status, [
					"pending",
					"workflow_started",
					"dead_letter",
				]),
			)
			.groupBy(productAnalyticsOutbox.eventName)
			.orderBy(asc(productAnalyticsOutbox.eventName)),
		db()
			.select({
				events: sql<number>`COUNT(*)`,
				attempts: sql<number>`COALESCE(SUM(${productAnalyticsEventReceipts.conflictCount}), 0)`,
			})
			.from(productAnalyticsEventReceipts)
			.where(gt(productAnalyticsEventReceipts.conflictCount, 0)),
		db()
			.select({
				attempts: sql<number>`COALESCE(SUM(${productAnalyticsReconciliationFailures.attemptCount}), 0)`,
				events: sql<number>`COUNT(*)`,
				sourceType: productAnalyticsReconciliationFailures.sourceType,
			})
			.from(productAnalyticsReconciliationFailures)
			.groupBy(productAnalyticsReconciliationFailures.sourceType)
			.orderBy(asc(productAnalyticsReconciliationFailures.sourceType)),
	]);
	const partitions = rows.map((row) => {
		const ageSeconds = (value: Date | string | null) => {
			if (!value) return 0;
			const timestamp =
				value instanceof Date ? value.getTime() : Date.parse(value);
			return Number.isFinite(timestamp)
				? Math.max(0, Math.floor((now.getTime() - timestamp) / 1_000))
				: 0;
		};
		const oldestActiveAgeSeconds = ageSeconds(row.oldestActiveAt);
		return {
			eventName: row.eventName,
			pending: Number(row.pending),
			due: Number(row.due),
			leased: Number(row.leased),
			deadLetter: Number(row.deadLetter),
			payloadConflict: Number(row.payloadConflict),
			workflowStarted: Number(row.workflowStarted),
			oldestPendingAgeSeconds: oldestActiveAgeSeconds,
			oldestActiveAgeSeconds,
			oldestDeadLetterAgeSeconds: ageSeconds(row.oldestDeadLetterAt),
		};
	});
	return {
		healthy:
			partitions.every(
				(row) =>
					row.deadLetter === 0 &&
					row.payloadConflict === 0 &&
					row.oldestActiveAgeSeconds * 1_000 <= OLDEST_PENDING_SLO_MS,
			) &&
			Number(receiptConflicts?.events ?? 0) === 0 &&
			reconciliationFailures.length === 0,
		oldestPendingSloSeconds: OLDEST_PENDING_SLO_MS / 1_000,
		receiptPayloadConflictEvents: Number(receiptConflicts?.events ?? 0),
		receiptPayloadConflictAttempts: Number(receiptConflicts?.attempts ?? 0),
		reconciliationFailures: reconciliationFailures.map((row) => ({
			attempts: Number(row.attempts),
			events: Number(row.events),
			sourceType: row.sourceType,
		})),
		capacityPerDay: MAX_DRAIN_BATCH_SIZE * 12 * 24,
		partitions,
	};
}
