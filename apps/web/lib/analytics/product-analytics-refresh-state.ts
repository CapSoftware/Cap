import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import {
	productAnalyticsErasureLeases,
	productAnalyticsIngestionLeases,
	productAnalyticsRefreshLeases,
} from "@cap/database/schema";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

const REFRESH_LEASE_NAME = "global";
const REFRESH_LEASE_DURATION_MS = 30 * 60 * 1_000;

const affectedRows = (result: unknown) =>
	Array.isArray(result)
		? ((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
		: ((result as { affectedRows?: number }).affectedRows ?? 0);

export async function acquireProductAnalyticsRefreshLease(sourceCutoff: Date) {
	const ownerId = randomUUID();
	const expiresAt = new Date(Date.now() + REFRESH_LEASE_DURATION_MS);
	return db().transaction(async (tx) => {
		await tx
			.insert(productAnalyticsErasureLeases)
			.values({ name: "global" })
			.onDuplicateKeyUpdate({ set: { name: "global" } });
		await tx
			.insert(productAnalyticsRefreshLeases)
			.values({ name: REFRESH_LEASE_NAME })
			.onDuplicateKeyUpdate({ set: { name: REFRESH_LEASE_NAME } });
		const [fence] = await tx
			.select({
				fencingToken: productAnalyticsErasureLeases.fencingToken,
				phase: productAnalyticsErasureLeases.phase,
			})
			.from(productAnalyticsErasureLeases)
			.where(eq(productAnalyticsErasureLeases.name, "global"))
			.limit(1)
			.for("update");
		if (!fence || fence.phase !== "idle") return undefined;
		const claimed = await tx
			.update(productAnalyticsRefreshLeases)
			.set({
				generation: sql`${productAnalyticsRefreshLeases.generation} + 1`,
				lastErrorCode: null,
				leaseExpiresAt: expiresAt,
				ownerId,
				sourceCutoff,
				status: "running",
			})
			.where(
				and(
					eq(productAnalyticsRefreshLeases.name, REFRESH_LEASE_NAME),
					or(
						isNull(productAnalyticsRefreshLeases.ownerId),
						lt(productAnalyticsRefreshLeases.leaseExpiresAt, new Date()),
					),
				),
			);
		if (affectedRows(claimed) === 0) return undefined;
		await tx.insert(productAnalyticsIngestionLeases).values({
			id: ownerId,
			fencingToken: fence.fencingToken,
			expiresAt,
		});
		return { ownerId, sourceCutoff: sourceCutoff.toISOString() };
	});
}

export async function renewProductAnalyticsRefreshLease(ownerId: string) {
	const expiresAt = new Date(Date.now() + REFRESH_LEASE_DURATION_MS);
	return db().transaction(async (tx) => {
		const refreshed = await tx
			.update(productAnalyticsRefreshLeases)
			.set({ leaseExpiresAt: expiresAt })
			.where(
				and(
					eq(productAnalyticsRefreshLeases.name, REFRESH_LEASE_NAME),
					eq(productAnalyticsRefreshLeases.ownerId, ownerId),
					eq(productAnalyticsRefreshLeases.status, "running"),
				),
			);
		if (affectedRows(refreshed) === 0) return false;
		const ingestion = await tx
			.update(productAnalyticsIngestionLeases)
			.set({ expiresAt })
			.where(eq(productAnalyticsIngestionLeases.id, ownerId));
		return affectedRows(ingestion) > 0;
	});
}

export async function releaseProductAnalyticsRefreshLease(
	ownerId: string,
	errorCode?: string,
) {
	await db().transaction(async (tx) => {
		await tx
			.delete(productAnalyticsIngestionLeases)
			.where(eq(productAnalyticsIngestionLeases.id, ownerId));
		await tx
			.update(productAnalyticsRefreshLeases)
			.set({
				lastCompletedAt: errorCode ? undefined : new Date(),
				lastErrorCode: errorCode ?? null,
				leaseExpiresAt: null,
				ownerId: null,
				status: errorCode ? "failed" : "idle",
			})
			.where(
				and(
					eq(productAnalyticsRefreshLeases.name, REFRESH_LEASE_NAME),
					eq(productAnalyticsRefreshLeases.ownerId, ownerId),
				),
			);
	});
}
