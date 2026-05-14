import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const STALE_EDIT_PROCESSING_START_MS = 15 * MINUTE;
const STALE_EDIT_PROCESSING_PROGRESS_MS = 10 * MINUTE;
const STALE_EDIT_THUMBNAIL_MS = 5 * MINUTE;

type UploadPhase =
	| "uploading"
	| "processing"
	| "generating_thumbnail"
	| "complete"
	| "error";

export function getEditSourceKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/source/original.mp4`;
}

export function isEditSourceKey({
	ownerId,
	videoId,
	rawFileKey,
}: {
	ownerId: string;
	videoId: string;
	rawFileKey: string | null | undefined;
}) {
	return rawFileKey === getEditSourceKey(ownerId, videoId);
}

function shouldClearEditUpload(input: {
	phase: UploadPhase;
	updatedAt: Date;
	processingProgress: number;
}) {
	if (input.phase === "error") {
		return true;
	}

	const ageMs = Date.now() - input.updatedAt.getTime();

	if (input.phase === "complete") {
		return ageMs > STALE_EDIT_THUMBNAIL_MS;
	}

	if (input.phase === "processing") {
		if (
			input.processingProgress === 0 &&
			ageMs > STALE_EDIT_PROCESSING_START_MS
		) {
			return true;
		}

		return ageMs > STALE_EDIT_PROCESSING_PROGRESS_MS;
	}

	if (input.phase === "generating_thumbnail") {
		return ageMs > STALE_EDIT_THUMBNAIL_MS;
	}

	return false;
}

export async function reconcileStaleEditUpload(videoId: Video.VideoId) {
	const [record] = await db()
		.select({
			ownerId: videos.ownerId,
			rawFileKey: videoUploads.rawFileKey,
			phase: videoUploads.phase,
			updatedAt: videoUploads.updatedAt,
			processingProgress: videoUploads.processingProgress,
		})
		.from(videos)
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, videoId));

	if (
		!record?.phase ||
		!record.updatedAt ||
		record.processingProgress == null ||
		!isEditSourceKey({
			ownerId: record.ownerId,
			videoId,
			rawFileKey: record.rawFileKey,
		}) ||
		!shouldClearEditUpload({
			phase: record.phase,
			updatedAt: record.updatedAt,
			processingProgress: record.processingProgress,
		})
	) {
		return false;
	}

	await db().delete(videoUploads).where(eq(videoUploads.videoId, videoId));
	return true;
}
