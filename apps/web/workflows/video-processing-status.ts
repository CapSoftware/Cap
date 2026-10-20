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
): Promise<"active" | "settled" | "unseen"> {
	"use step";

	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL) return "unseen";
	const observation = await observeDesktopRecordingJob({
		videoId,
		jobId,
		mediaServerUrl: env.MEDIA_SERVER_URL,
		webhookUrl: `${env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL}/api/webhooks/media-server/progress?retryable=true`,
		secret: env.MEDIA_SERVER_WEBHOOK_SECRET,
	});
	if (observation.status === "active") {
		await db()
			.update(videoUploads)
			.set({ updatedAt: new Date() })
			.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));
		return "active";
	}
	return observation.delivered ? "settled" : "unseen";
}

export const VIDEO_PROCESSING_STALL_MS = 20 * 60 * 1000;
export const UNSEEN_JOB_GRACE_MS = 10 * 60 * 1000;
const UNSEEN_JOB_POLL_MS = 30_000;

export async function waitForVideoProcessing(
	videoId: string,
	{
		jobId,
		stallMs = VIDEO_PROCESSING_STALL_MS,
		maxPollMs = 30_000,
	}: { jobId?: string; stallMs?: number; maxPollMs?: number } = {},
): Promise<ProcessedVideoMetadata> {
	let lastMessage: string | null = null;
	let lastUpdatedAt: number | null = null;
	let lastChangeAt = Date.now();
	let jobActive = false;
	let unseenSince: number | null = null;
	for (let attempt = 0; ; attempt++) {
		const result = await readVideoProcessingStatus(videoId);
		if (result.status === "complete") return result.metadata;
		if (result.status === "failed") {
			throw new VideoProcessingFailedError(result.message);
		}
		if (result.status === "error") throw new FatalError(result.message);
		const changed =
			result.message !== lastMessage ||
			(!jobActive && result.updatedAt !== lastUpdatedAt);
		lastMessage = result.message;
		lastUpdatedAt = result.updatedAt;
		if (changed) {
			lastChangeAt = Date.now();
			jobActive = false;
			unseenSince = null;
		} else if (
			jobActive ||
			unseenSince !== null ||
			Date.now() - lastChangeAt > stallMs
		) {
			const job = jobId ? await checkMediaServerJob(videoId, jobId) : "unseen";
			jobActive = job === "active";
			if (job === "unseen") {
				unseenSince ??= Date.now();
				if (!jobId || Date.now() - unseenSince >= UNSEEN_JOB_GRACE_MS) {
					throw new VideoProcessingFailedError(
						`Video processing stopped making progress while ${result.message}`,
					);
				}
			} else {
				unseenSince = null;
				lastChangeAt = Date.now();
			}
		}
		await sleep(
			unseenSince === null
				? Math.min(5_000 * (attempt + 1), maxPollMs)
				: Math.min(UNSEEN_JOB_POLL_MS, maxPollMs),
		);
	}
}
