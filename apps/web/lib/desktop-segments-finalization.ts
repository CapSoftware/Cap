import { db } from "@cap/database";
import { videoUploads } from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { and, eq, notInArray } from "drizzle-orm";
import { start } from "workflow/api";
import { finalizeDesktopRecordingWorkflow } from "@/workflows/finalize-desktop-recording";

export { isRetryableDesktopSegmentsFinalizationError } from "@/lib/desktop-segments-retryable-errors";

export type DesktopSegmentsFinalizationStatus = "queued" | "already-processing";

const PROCESSING_MESSAGE = "Muxing segments into MP4...";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function queueDesktopSegmentsFinalization({
	videoId,
	userId,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
}): Promise<DesktopSegmentsFinalizationStatus> {
	const result = await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: PROCESSING_MESSAGE,
			processingError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				notInArray(videoUploads.phase, ["processing", "generating_thumbnail"]),
			),
		);

	if (getAffectedRows(result) === 0) {
		const [existing] = await db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId));

		if (existing) {
			return "already-processing";
		}

		try {
			await db().insert(videoUploads).values({
				videoId,
				phase: "processing",
				processingProgress: 0,
				processingMessage: PROCESSING_MESSAGE,
			});
		} catch {
			return "already-processing";
		}
	}

	try {
		await start(finalizeDesktopRecordingWorkflow, [
			{
				videoId,
				userId,
			},
		]);
		return "queued";
	} catch (error) {
		await db()
			.update(videoUploads)
			.set({
				phase: "error",
				processingProgress: 0,
				processingMessage: "Failed to queue segment muxing",
				processingError: error instanceof Error ? error.message : String(error),
				updatedAt: new Date(),
			})
			.where(eq(videoUploads.videoId, videoId));

		throw error;
	}
}
