import { db } from "@cap/database";
import { videoProcessingJobs } from "@cap/database/schema";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";

const RECOVERY_GRACE_MS = 30 * 60 * 1_000;

const countsSchema = z.object({
	stalledWorkers: z.number().int().nonnegative(),
	stalledCommits: z.number().int().nonnegative(),
	retryLoops: z.number().int().nonnegative(),
	blockedCommittedSources: z.number().int().nonnegative(),
	changedSources: z.number().int().nonnegative(),
});

export async function getDesktopRecordingHealth({
	now = new Date(),
}: {
	now?: Date;
} = {}) {
	const staleBefore = new Date(now.getTime() - RECOVERY_GRACE_MS);
	const job = videoProcessingJobs;
	const [row] = await db()
		.select({
			stalledWorkers:
				sql<number>`COALESCE(SUM(CASE WHEN ${job.state} = 'processing' AND (${job.leaseExpiresAt} <= ${staleBefore} OR (${job.leaseExpiresAt} IS NULL AND ${job.updatedAt} <= ${staleBefore})) THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
			stalledCommits:
				sql<number>`COALESCE(SUM(CASE WHEN ${job.state} = 'committing' AND ${job.updatedAt} <= ${staleBefore} AND (${job.leaseExpiresAt} IS NULL OR ${job.leaseExpiresAt} <= ${staleBefore}) THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
			retryLoops:
				sql<number>`COALESCE(SUM(CASE WHEN ${job.state} IN ('processing', 'retry', 'queued') AND ${job.source} IS NOT NULL AND ${job.attemptCount} >= 5 THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
			blockedCommittedSources:
				sql<number>`COALESCE(SUM(CASE WHEN ${job.state} = 'source-blocked' AND ${job.source} IS NOT NULL AND COALESCE(${job.errorCode}, '') NOT IN ('output-replaced', 'video-deleting') THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
			changedSources:
				sql<number>`COALESCE(SUM(CASE WHEN ${job.state} = 'source-blocked' AND ${job.errorCode} = 'source-changed' THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
		})
		.from(job)
		.where(
			inArray(job.state, [
				"processing",
				"committing",
				"retry",
				"queued",
				"source-blocked",
			]),
		);
	const counts = countsSchema.parse(row);
	return {
		status: Object.values(counts).some((count) => count > 0)
			? ("degraded" as const)
			: ("healthy" as const),
		checkedAt: now.toISOString(),
		scope: "unresolved" as const,
		...counts,
	};
}
