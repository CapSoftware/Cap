import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import {
	productAnalyticsErasureLeases,
	productAnalyticsIngestionLeases,
	productAnalyticsOutbox,
} from "@cap/database/schema";
import { and, eq, inArray } from "drizzle-orm";

function terminalEvent(deliveryKey: string, payloadHash: string) {
	return and(
		eq(productAnalyticsOutbox.deliveryKey, deliveryKey),
		eq(productAnalyticsOutbox.payloadHash, payloadHash),
		inArray(productAnalyticsOutbox.status, ["pending", "workflow_started"]),
	);
}

export async function acquireProductAnalyticsIngestionLease() {
	await db()
		.insert(productAnalyticsErasureLeases)
		.values({ name: "global" })
		.onDuplicateKeyUpdate({ set: { name: "global" } });
	const [erasureLease] = await db()
		.select({
			fencingToken: productAnalyticsErasureLeases.fencingToken,
			phase: productAnalyticsErasureLeases.phase,
		})
		.from(productAnalyticsErasureLeases)
		.where(eq(productAnalyticsErasureLeases.name, "global"))
		.limit(1);
	if (!erasureLease || erasureLease.phase !== "idle") return undefined;
	const leaseId = randomUUID();
	await db()
		.insert(productAnalyticsIngestionLeases)
		.values({
			id: leaseId,
			fencingToken: erasureLease.fencingToken,
			expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
		});
	const [confirmed] = await db()
		.select({
			fencingToken: productAnalyticsErasureLeases.fencingToken,
			phase: productAnalyticsErasureLeases.phase,
		})
		.from(productAnalyticsErasureLeases)
		.where(eq(productAnalyticsErasureLeases.name, "global"))
		.limit(1);
	if (
		!confirmed ||
		confirmed.phase !== "idle" ||
		confirmed.fencingToken !== erasureLease.fencingToken
	) {
		await releaseProductAnalyticsIngestionLease(leaseId);
		return undefined;
	}
	return leaseId;
}

export async function releaseProductAnalyticsIngestionLease(leaseId: string) {
	await db()
		.delete(productAnalyticsIngestionLeases)
		.where(eq(productAnalyticsIngestionLeases.id, leaseId));
}

export async function markProductAnalyticsOutboxDelivered(
	deliveryKey: string,
	payloadHash: string,
	errorCode?: "identity_suppressed",
) {
	await db()
		.update(productAnalyticsOutbox)
		.set({
			status: "delivered",
			deliveredAt: new Date(),
			lastErrorCode: errorCode ?? null,
			leaseOwnerId: null,
			leaseExpiresAt: null,
		})
		.where(terminalEvent(deliveryKey, payloadHash));
}

export async function deleteSuppressedProductAnalyticsOutboxRow(
	deliveryKey: string,
	payloadHash: string,
) {
	await db()
		.delete(productAnalyticsOutbox)
		.where(terminalEvent(deliveryKey, payloadHash));
}

export async function markProductAnalyticsOutboxDeadLetter(
	deliveryKey: string,
	payloadHash: string,
	errorCode:
		| "contract_invalid"
		| "delivery_not_configured"
		| "provider_rejected",
) {
	await db()
		.update(productAnalyticsOutbox)
		.set({
			status: "dead_letter",
			deadLetteredAt: new Date(),
			lastErrorCode: errorCode,
			leaseOwnerId: null,
			leaseExpiresAt: null,
		})
		.where(terminalEvent(deliveryKey, payloadHash));
}

export async function markProductAnalyticsOutboxRetrying(
	deliveryKey: string,
	payloadHash: string,
	errorCode:
		| "provider_retryable"
		| "staging_provider_429"
		| "staging_provider_503"
		| "staging_timeout_after_accept" = "provider_retryable",
) {
	await db()
		.update(productAnalyticsOutbox)
		.set({ lastErrorCode: errorCode })
		.where(terminalEvent(deliveryKey, payloadHash));
}
