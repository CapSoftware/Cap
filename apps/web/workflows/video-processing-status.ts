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
	| { status: "pending"; message: string; updatedAt: number | null }
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
			updatedAt: videoUploads.updatedAt,
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
		updatedAt: upload.updatedAt ? upload.updatedAt.getTime() : null,
	};
}

export const VIDEO_PROCESSING_STALL_MS = 20 * 60 * 1000;

export async function waitForVideoProcessing(
	videoId: string,
	{
		stallMs = VIDEO_PROCESSING_STALL_MS,
		maxPollMs = 30_000,
	}: { stallMs?: number; maxPollMs?: number } = {},
): Promise<ProcessedVideoMetadata> {
	let lastSeen: string | null = null;
	let lastChangeAt = Date.now();
	for (let attempt = 0; ; attempt++) {
		const result = await readVideoProcessingStatus(videoId);
		if (result.status === "complete") return result.metadata;
		if (result.status === "failed") {
			throw new VideoProcessingFailedError(result.message);
		}
		if (result.status === "error") throw new FatalError(result.message);
		const seen = `${result.message}|${result.updatedAt ?? ""}`;
		if (seen !== lastSeen) {
			lastSeen = seen;
			lastChangeAt = Date.now();
		} else if (Date.now() - lastChangeAt > stallMs) {
			throw new VideoProcessingFailedError(
				`Video processing stopped making progress while ${result.message}`,
			);
		}
		await sleep(Math.min(5_000 * (attempt + 1), maxPollMs));
	}
}
