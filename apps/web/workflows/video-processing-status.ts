import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError, sleep } from "workflow";

export interface ProcessedVideoMetadata {
	duration: number;
	width: number;
	height: number;
	fps: number;
}

type ProcessingStatus =
	| { status: "complete"; metadata: ProcessedVideoMetadata }
	| { status: "pending"; message: string }
	| { status: "failed"; message: string }
	| { status: "error"; message: string };

export class VideoProcessingFailedError extends Error {}

function isPositiveNumber(value: number | null): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export async function readVideoProcessingStatus(
	videoId: string,
): Promise<ProcessingStatus> {
	"use step";

	const [upload] = await db()
		.select({
			phase: videoUploads.phase,
			processingProgress: videoUploads.processingProgress,
			processingMessage: videoUploads.processingMessage,
			processingError: videoUploads.processingError,
		})
		.from(videoUploads)
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));

	if (!upload || upload.phase === "complete") {
		const [video] = await db()
			.select({
				duration: videos.duration,
				width: videos.width,
				height: videos.height,
				fps: videos.fps,
			})
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)));
		if (
			!video ||
			!isPositiveNumber(video.width) ||
			!isPositiveNumber(video.height) ||
			!isPositiveNumber(video.fps)
		) {
			return {
				status: "error",
				message: "Processing completed but video metadata is missing",
			};
		}
		return {
			status: "complete",
			metadata: {
				duration: isPositiveNumber(video.duration) ? video.duration : 0,
				width: video.width,
				height: video.height,
				fps: video.fps,
			},
		};
	}
	if (upload.processingError || upload.phase === "error") {
		return {
			status: "failed",
			message:
				upload.processingError ||
				upload.processingMessage ||
				"Video processing failed",
		};
	}
	return {
		status: "pending",
		message: [
			upload.phase,
			typeof upload.processingProgress === "number"
				? `${upload.processingProgress}%`
				: null,
			upload.processingMessage,
		]
			.filter(Boolean)
			.join(" "),
	};
}

export async function waitForVideoProcessing(
	videoId: string,
): Promise<ProcessedVideoMetadata> {
	const deadline = Date.now() + 60 * 60 * 1000;
	let lastStatus = "processing";
	for (let attempt = 0; Date.now() < deadline; attempt++) {
		const result = await readVideoProcessingStatus(videoId);
		if (result.status === "complete") return result.metadata;
		if (result.status === "failed") {
			throw new VideoProcessingFailedError(result.message);
		}
		if (result.status === "error") throw new FatalError(result.message);
		lastStatus = result.message;
		await sleep(Math.min(5_000 * (attempt + 1), 30_000));
	}
	throw new FatalError(`Video processing timed out while ${lastStatus}`);
}
