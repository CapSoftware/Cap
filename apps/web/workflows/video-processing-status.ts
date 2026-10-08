import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError, sleep } from "workflow";
import { observeDesktopRecordingJob } from "@/lib/desktop-recording-job-status";

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

export async function checkMediaServerJob(
	videoId: string,
	jobId: string,
): Promise<"active" | "settled" | "missing"> {
	"use step";

	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL) return "missing";
	const observation = await observeDesktopRecordingJob({
		videoId,
		jobId,
		mediaServerUrl: env.MEDIA_SERVER_URL,
		webhookUrl: `${env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL}/api/webhooks/media-server/progress?retryable=true`,
		secret: env.MEDIA_SERVER_WEBHOOK_SECRET,
	});
	if (observation.status === "active") return "active";
	return observation.delivered ? "settled" : "missing";
}

export const VIDEO_PROCESSING_STALL_MS = 20 * 60 * 1000;

export async function waitForVideoProcessing(
	videoId: string,
	{
		jobId,
		stallMs = VIDEO_PROCESSING_STALL_MS,
		maxPollMs = 30_000,
	}: { jobId?: string; stallMs?: number; maxPollMs?: number } = {},
): Promise<ProcessedVideoMetadata> {
	let lastSeen: string | null = null;
	let lastChangeAt = Date.now();
	let updatesMissing = false;
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
			updatesMissing = false;
		} else if (updatesMissing || Date.now() - lastChangeAt > stallMs) {
			const job = jobId ? await checkMediaServerJob(videoId, jobId) : "missing";
			if (job === "missing") {
				throw new VideoProcessingFailedError(
					`Video processing stopped making progress while ${result.message}`,
				);
			}
			updatesMissing = job === "active";
			lastChangeAt = Date.now();
		}
		await sleep(Math.min(5_000 * (attempt + 1), maxPollMs));
	}
}
