import { db } from "@cap/database";
import { importedVideos, videos, videoUploads } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import {
	getLoomImportRunState,
	LoomImportStartError,
	restoreLoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";

const ABANDONED_PROCESSING_AGE_MS = 10 * 60 * 1000;
const FINISHED_WORKER_AGE_MS = 60 * 60 * 1000;
const STALE_PROCESSING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type LoomRedriveOutcome =
	| { videoId: string; status: "restarted" }
	| { videoId: string; status: "skipped" | "failed"; reason: string };

function getAffectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export async function redriveLoomImport(
	videoId: string,
	now = new Date(),
): Promise<LoomRedriveOutcome> {
	const id = Video.VideoId.make(videoId);
	const [row] = await db()
		.select({
			ownerId: videos.ownerId,
			bucketId: videos.bucket,
			metadata: videos.metadata,
			phase: videoUploads.phase,
			rawFileKey: videoUploads.rawFileKey,
			uploadUpdatedAt: videoUploads.updatedAt,
			loomVideoId: importedVideos.sourceId,
		})
		.from(videos)
		.innerJoin(
			importedVideos,
			and(
				eq(importedVideos.id, videos.id),
				eq(importedVideos.orgId, videos.orgId),
				eq(importedVideos.source, "loom"),
			),
		)
		.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
		.where(eq(videos.id, id))
		.limit(1);
	if (!row)
		return {
			videoId,
			status: "skipped",
			reason: "not an unfinished Loom import",
		};
	const age = now.getTime() - row.uploadUpdatedAt.getTime();
	const stalled =
		(row.phase === "processing" || row.phase === "uploading") &&
		age > STALE_PROCESSING_AGE_MS;
	const runState = await getLoomImportRunState(row.metadata?.loomImportRun);
	const abandoned =
		row.phase === "processing" &&
		runState === "inactive" &&
		age > ABANDONED_PROCESSING_AGE_MS;
	if (row.phase !== "error" && !stalled && !abandoned)
		return { videoId, status: "skipped", reason: `phase ${row.phase}` };
	if (runState === "pending" || runState === "active")
		return { videoId, status: "skipped", reason: `run ${runState}` };
	if (runState === "unconfirmed" && age < FINISHED_WORKER_AGE_MS)
		return { videoId, status: "skipped", reason: "run unconfirmed" };

	const rawFileKey = row.rawFileKey ?? `${row.ownerId}/${id}/raw-upload.mp4`;
	const claimedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
	const claim = await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Restarting Loom import...",
			processingError: null,
			rawFileKey,
			updatedAt: claimedAt,
		})
		.where(
			and(
				eq(videoUploads.videoId, id),
				eq(videoUploads.phase, row.phase),
				eq(videoUploads.updatedAt, row.uploadUpdatedAt),
			),
		);
	if (getAffectedRows(claim) !== 1)
		return { videoId, status: "skipped", reason: "already restarting" };

	try {
		await startLoomImportWorkflow({
			videoId: id,
			userId: row.ownerId,
			rawFileKey,
			bucketId: row.bucketId,
			loomVideoId: row.loomVideoId,
			reuseExistingRawUpload: true,
			importPriority: "bulk",
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Loom import could not restart.";
		if (error instanceof LoomImportStartError && error.canRetry)
			await restoreLoomImportStartError(id, "processing", claimedAt, message);
		return { videoId, status: "failed", reason: message };
	}
	return { videoId, status: "restarted" };
}
