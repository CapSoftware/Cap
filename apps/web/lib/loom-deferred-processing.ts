import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

function getAffectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export function getPendingLoomProcessing(
	metadata: VideoMetadata | null | undefined,
	ownerId: string,
	videoId: string,
) {
	const deferred = metadata?.loomDeferredProcessing;
	if (
		deferred?.status !== "pending" ||
		typeof deferred.rawFileKey !== "string" ||
		!deferred.rawFileKey.startsWith(`${ownerId}/${videoId}/`)
	)
		return null;
	return deferred.rawFileKey;
}

export async function startDeferredLoomProcessing({
	videoId,
	ownerId,
	bucketId,
	rawFileKey,
}: {
	videoId: Video.VideoId;
	ownerId: string;
	bucketId: string | null;
	rawFileKey: string;
}) {
	const claim = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.loomDeferredProcessing.status', 'started', '$.loomDeferredProcessing.startedAt', ${new Date().toISOString()})`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.status')) = 'pending'`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.rawFileKey')) = ${rawFileKey}`,
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
		.onDuplicateKeyUpdate({ set: { rawFileKey } });

	return startVideoProcessingWorkflow({
		videoId,
		userId: ownerId,
		rawFileKey,
		bucketId,
		processingMessage: "Optimizing imported video...",
		startFailureMessage: "Imported video could not be optimized",
	});
}
