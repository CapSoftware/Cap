import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { LOOM_REASSIGN_CLAIM_TTL_MS } from "@/lib/loom-original-key";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export const DEFERRED_PROCESSING_RECLAIM_MS = 30 * 60 * 1000;

function getAffectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export function getPendingLoomProcessing(
	metadata: VideoMetadata | null | undefined,
	ownerId: string,
	videoId: string,
	now = Date.now(),
) {
	const deferred = metadata?.loomDeferredProcessing;
	if (
		!deferred ||
		typeof deferred.rawFileKey !== "string" ||
		!deferred.rawFileKey.startsWith(`${ownerId}/${videoId}/`)
	)
		return null;
	if (deferred.status === "pending") return deferred.rawFileKey;
	const startedAt = Date.parse(deferred.startedAt ?? "");
	return deferred.status === "started" &&
		Number.isFinite(startedAt) &&
		now - startedAt > DEFERRED_PROCESSING_RECLAIM_MS
		? deferred.rawFileKey
		: null;
}

export async function startDeferredLoomProcessing(
	{
		videoId,
		ownerId,
		bucketId,
		rawFileKey,
	}: {
		videoId: Video.VideoId;
		ownerId: string;
		bucketId: string | null;
		rawFileKey: string;
	},
	now = new Date(),
) {
	const startedAt = now.toISOString();
	const reclaimBefore = new Date(
		now.getTime() - DEFERRED_PROCESSING_RECLAIM_MS,
	).toISOString();
	const claim = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.loomDeferredProcessing.status', 'started', '$.loomDeferredProcessing.startedAt', ${startedAt})`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.rawFileKey')) = ${rawFileKey}`,
				sql`(JSON_EXTRACT(${videos.metadata}, '$.loomReassignClaim') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomReassignClaim.at')) < ${new Date(now.getTime() - LOOM_REASSIGN_CLAIM_TTL_MS).toISOString()})`,
				sql`(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.status')) = 'pending' OR (JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.status')) = 'started' AND JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.startedAt')) < ${reclaimBefore}))`,
			),
		);
	if (getAffectedRows(claim) !== 1) return "already-started" as const;

	await db()
		.insert(videoUploads)
		.values({
			videoId,
			mode: "singlepart",
			phase: "uploading",
			rawFileKey,
			processingMessage: "Optimizing imported video...",
		})
		.onDuplicateKeyUpdate({ set: { rawFileKey, phase: "uploading" } });
	return startVideoProcessingWorkflow({
		videoId,
		userId: ownerId,
		rawFileKey,
		bucketId,
		processingMessage: "Optimizing imported video...",
		startFailureMessage: "Imported video could not be optimized",
	});
}
