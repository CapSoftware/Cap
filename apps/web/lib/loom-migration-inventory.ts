import { db } from "@cap/database";
import {
	loomMigrationImports,
	loomMigrationRequests,
	videos,
} from "@cap/database/schema";
import { and, eq, inArray, isNull, notExists } from "drizzle-orm";
import { requireMigrationOperator } from "@/lib/loom-concierge";
import { LoomMigrationError } from "@/lib/loom-migration-state";

const RECONCILE_BATCH_SIZE = 100;

export async function reconcileMissingLoomMigrationImports({
	requestId,
	verified,
}: {
	requestId: string;
	verified: boolean;
}) {
	const operator = await requireMigrationOperator();
	if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{15}$/.test(requestId))
		throw new LoomMigrationError("Invalid migration request.");
	if (verified !== true)
		throw new LoomMigrationError(
			"Reconcile deleted recordings against the source list first.",
		);
	return db().transaction(async (tx) => {
		const [request] = await tx
			.select()
			.from(loomMigrationRequests)
			.where(eq(loomMigrationRequests.id, requestId))
			.limit(1)
			.for("update");
		if (
			!request ||
			request.status === "completed" ||
			request.activeOrganizationId !== request.organizationId ||
			(request.activeImportCount > 0 &&
				(!request.activeImportLeaseUntil ||
					request.activeImportLeaseUntil > new Date()))
		) {
			throw new LoomMigrationError(
				"The migration is inactive or imports are starting. Refresh and try again.",
			);
		}
		const missing = await tx
			.select({ videoId: loomMigrationImports.videoId })
			.from(loomMigrationImports)
			.leftJoin(videos, eq(videos.id, loomMigrationImports.videoId))
			.where(
				and(eq(loomMigrationImports.requestId, requestId), isNull(videos.id)),
			)
			.limit(RECONCILE_BATCH_SIZE + 1)
			.for("update");
		if (missing.length === 0) return { removedCount: 0, hasMore: false };
		const result = await tx.delete(loomMigrationImports).where(
			and(
				eq(loomMigrationImports.requestId, requestId),
				inArray(
					loomMigrationImports.videoId,
					missing.slice(0, RECONCILE_BATCH_SIZE).map((row) => row.videoId),
				),
				notExists(
					tx
						.select({ id: videos.id })
						.from(videos)
						.where(eq(videos.id, loomMigrationImports.videoId)),
				),
			),
		);
		const removedCount = (Array.isArray(result) ? result[0] : result) as {
			affectedRows?: number;
		};
		if (typeof removedCount.affectedRows !== "number")
			throw new Error("Could not verify inventory reconciliation");
		const now = new Date();
		await tx
			.update(loomMigrationRequests)
			.set({
				lastOperatorUserId: operator.id,
				lastOperatorAt: now,
				updatedAt: now,
			})
			.where(eq(loomMigrationRequests.id, requestId));
		return {
			removedCount: removedCount.affectedRows,
			hasMore: missing.length > RECONCILE_BATCH_SIZE,
		};
	});
}
