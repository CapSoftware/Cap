import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

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
		if (webhookSecret) {
			const authHeader = request.headers.get("x-media-server-secret");
			if (authHeader !== webhookSecret) {
				return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
			}
		}

		const payload: ProgressWebhookPayload = await request.json();

		console.log(
			`[media-server-webhook] Received progress update for video ${payload.videoId}: ${payload.phase} (${payload.progress}%)`,
		);

		const dbPhase = mapPhaseToDbPhase(payload.phase);

		if (dbPhase === "complete") {
			if (payload.metadata) {
				await db()
					.update(videos)
					.set({
						width: payload.metadata.width,
						height: payload.metadata.height,
						duration: payload.metadata.duration,
					})
					.where(eq(videos.id, payload.videoId as Video.VideoId));
			}

			await db()
				.delete(videoUploads)
				.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));
		} else if (dbPhase === "error") {
			await db()
				.update(videoUploads)
				.set({
					phase: "error",
					processingError: payload.error || payload.message || "Unknown error",
					processingMessage: payload.message,
					updatedAt: new Date(),
				})
				.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));
		} else {
			await db()
				.update(videoUploads)
				.set({
					phase: dbPhase,
					processingProgress: Math.round(payload.progress),
					processingMessage: payload.message,
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
