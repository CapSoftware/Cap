import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { invalidateGoogleDriveStorageQuotaCache } from "@/lib/google-drive-storage-quota";
import { isEditSourceKey } from "@/lib/video-edit-processing";

interface ProgressWebhookPayload {
	jobId: string;
	videoId: string;
	phase:
		| "queued"
		| "downloading"
		| "probing"
		| "processing"
		| "uploading"
		| "generating_thumbnail"
		| "complete"
		| "error"
		| "cancelled";
	progress: number;
	message?: string;
	error?: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
		videoCodec: string;
		audioCodec: string | null;
		audioChannels: number | null;
		sampleRate: number | null;
		bitrate: number;
		fileSize: number;
	};
}

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function mapPhaseToDbPhase(
	phase: ProgressWebhookPayload["phase"],
): "uploading" | "processing" | "generating_thumbnail" | "complete" | "error" {
	switch (phase) {
		case "queued":
		case "downloading":
		case "probing":
		case "processing":
		case "uploading":
			return "processing";
		case "generating_thumbnail":
			return "generating_thumbnail";
		case "complete":
			return "complete";
		case "error":
		case "cancelled":
			return "error";
		default:
			return "processing";
	}
}

export async function POST(request: NextRequest) {
	try {
		const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
		const authHeader = request.headers.get("x-media-server-secret");
		// Hash both sides to a fixed-length digest before the constant-time
		// compare. This avoids comparing raw inputs whose UTF-8 byte length can
		// differ from their UTF-16 `.length` (which would throw a RangeError) and
		// removes the length pre-check that would otherwise leak the secret size.
		const digest = (value: string) =>
			createHash("sha256").update(value, "utf8").digest();
		if (
			!webhookSecret ||
			!authHeader ||
			!timingSafeEqual(digest(authHeader), digest(webhookSecret))
		) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const payload: ProgressWebhookPayload = await request.json();
		const isRetryableWorkflowError =
			request.nextUrl.searchParams.get("retryable") === "true" &&
			payload.phase === "error";

		console.log(
			"[media-server-webhook] Received progress update for video %s: %s (%d%%)",
			payload.videoId,
			payload.phase,
			payload.progress,
		);

		const dbPhase = mapPhaseToDbPhase(payload.phase);

		if (dbPhase === "complete") {
			if (payload.metadata) {
				const duration = getValidDuration(payload.metadata.duration);
				await db()
					.update(videos)
					.set({
						width: payload.metadata.width,
						height: payload.metadata.height,
						fps: payload.metadata.fps,
						...(duration === undefined ? {} : { duration }),
					})
					.where(eq(videos.id, payload.videoId as Video.VideoId));
			}

			const [currentVideo] = await db()
				.select()
				.from(videos)
				.where(eq(videos.id, payload.videoId as Video.VideoId));
			const [currentUpload] = await db()
				.select({ rawFileKey: videoUploads.rawFileKey })
				.from(videoUploads)
				.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));

			if (currentVideo?.source?.type === "desktopSegments") {
				await db()
					.update(videos)
					.set({ source: { type: "desktopMP4" as const } })
					.where(eq(videos.id, payload.videoId as Video.VideoId));
			}

			const isEditUpload =
				currentVideo &&
				isEditSourceKey({
					ownerId: currentVideo.ownerId,
					videoId: payload.videoId,
					rawFileKey: currentUpload?.rawFileKey,
				});

			if (isEditUpload) {
				await db()
					.update(videoUploads)
					.set({
						phase: "complete",
						processingProgress: 100,
						processingMessage: payload.message,
						processingError: null,
						updatedAt: new Date(),
					})
					.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));
			} else {
				await db()
					.delete(videoUploads)
					.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));
			}
			await invalidateGoogleDriveStorageQuotaCache(
				currentVideo?.storageIntegrationId,
			);
		} else if (dbPhase === "error") {
			const processingError =
				payload.error || payload.message || "Unknown error";
			if (isRetryableWorkflowError) {
				await db()
					.update(videoUploads)
					.set({
						phase: "processing",
						processingProgress: Math.round(payload.progress),
						processingError,
						processingMessage: "Retrying video processing...",
						updatedAt: new Date(),
					})
					.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));
			} else {
				await db()
					.update(videoUploads)
					.set({
						phase: "error",
						processingError,
						processingMessage: payload.message,
						updatedAt: new Date(),
					})
					.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));
			}
		} else {
			await db()
				.update(videoUploads)
				.set({
					phase: dbPhase,
					processingProgress: Math.round(payload.progress),
					processingMessage: payload.message,
					processingError: null,
					updatedAt: new Date(),
				})
				.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));
		}

		return NextResponse.json({ success: true });
	} catch (error) {
		console.error("[media-server-webhook] Error processing webhook:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
