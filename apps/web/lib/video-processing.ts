import { db } from "@cap/database";
import { videoUploads } from "@cap/database/schema";
import type { S3Bucket, Video } from "@cap/web-domain";
import { and, eq, ne } from "drizzle-orm";
import { start } from "workflow/api";
import { processVideoWorkflow } from "@/workflows/process-video";

export type VideoProcessingStartStatus = "started" | "already-processing";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function setVideoProcessingError(
	videoId: Video.VideoId,
	processingMessage: string,
	error: unknown,
): Promise<void> {
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage,
			processingError: error instanceof Error ? error.message : String(error),
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId));
}

export async function transitionVideoToProcessing({
	videoId,
	rawFileKey,
	processingMessage,
	mode,
	forceRestart,
}: {
	videoId: Video.VideoId;
	rawFileKey: string;
	processingMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
}): Promise<VideoProcessingStartStatus> {
	const result = await db()
		.update(videoUploads)
		.set({
			...(mode ? { mode } : {}),
			phase: "processing",
			processingProgress: 0,
			processingMessage,
			processingError: null,
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(
			forceRestart
				? eq(videoUploads.videoId, videoId)
				: and(
						eq(videoUploads.videoId, videoId),
						ne(videoUploads.phase, "processing"),
					),
		);

	if (getAffectedRows(result) > 0) {
		return "started";
	}

	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));

	if (!upload) {
		throw new Error("No upload record found");
	}

	if (upload.phase === "processing") {
		return "already-processing";
	}

	throw new Error("Failed to transition upload to processing");
}

export async function startVideoProcessingWorkflow({
	videoId,
	userId,
	rawFileKey,
	bucketId,
	processingMessage,
	startFailureMessage,
	mode,
	forceRestart,
}: {
	videoId: Video.VideoId;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	processingMessage: string;
	startFailureMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
}): Promise<VideoProcessingStartStatus> {
	const status = await transitionVideoToProcessing({
		videoId,
		rawFileKey,
		processingMessage,
		mode,
		forceRestart,
	});

	if (status === "already-processing") {
		return status;
	}

	try {
		await start(processVideoWorkflow, [
			{
				videoId,
				userId,
				rawFileKey,
				bucketId: bucketId as S3Bucket.S3BucketId | null,
			},
		]);
		return "started";
	} catch (error) {
		const normalizedError =
			error instanceof Error
				? error
				: new Error("Video processing could not start");
		await setVideoProcessingError(
			videoId,
			startFailureMessage,
			normalizedError,
		);
		throw normalizedError;
	}
}
