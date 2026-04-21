import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { runPromise } from "@/lib/server";

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
		if (webhookSecret && authHeader !== webhookSecret) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const payload: ProgressWebhookPayload = await request.json();

		console.log(
			"[media-server-webhook] Received progress update for video %s: %s (%d%%)",
			payload.videoId,
			payload.phase,
			payload.progress,
		);

		const dbPhase = mapPhaseToDbPhase(payload.phase);

		console.log(
			"[media-server-webhook] Mapped to dbPhase=%s for video %s",
			dbPhase,
			payload.videoId,
		);

		if (dbPhase === "complete") {
			if (payload.metadata) {
				const duration = getValidDuration(payload.metadata.duration);
				await db()
					.update(videos)
					.set({
						width: payload.metadata.width,
						height: payload.metadata.height,
						...(duration === undefined ? {} : { duration }),
					})
					.where(eq(videos.id, payload.videoId as Video.VideoId));
			}

			const [currentVideo] = await db()
				.select({
					source: videos.source,
					ownerId: videos.ownerId,
					bucket: videos.bucket,
				})
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

				const videoId = payload.videoId;
				const ownerId = currentVideo.ownerId;

				if (ownerId) {
					const segmentsPrefix = `${ownerId}/${videoId}/segments/`;
					Effect.gen(function* () {
						const bucketId = Option.fromNullable(
							currentVideo.bucket,
						) as Option.Option<S3Bucket.S3BucketId>;
						const [bucket] = yield* S3Buckets.getBucketAccess(bucketId);
						let totalDeleted = 0;
						let continuationToken: string | undefined;

						do {
							const listed = yield* bucket.listObjects({
								prefix: segmentsPrefix,
								continuationToken,
							});
							if (listed.Contents && listed.Contents.length > 0) {
								yield* bucket.deleteObjects(
									listed.Contents.map((c: { Key?: string }) => ({
										Key: c.Key,
									})),
								);
								totalDeleted += listed.Contents.length;
							}
							continuationToken = listed.IsTruncated
								? listed.NextContinuationToken
								: undefined;
						} while (continuationToken);

						if (totalDeleted > 0) {
							console.log(
								"[media-server-webhook] Cleaned up %d segment objects for %s",
								totalDeleted,
								videoId,
							);
						}
					})
						.pipe(runPromise)
						.catch((err) => {
							console.warn(
								"[media-server-webhook] Failed to clean up segments for %s:",
								videoId,
								err,
							);
						});
				}
			}

			await db()
				.delete(videoUploads)
				.where(eq(videoUploads.videoId, payload.videoId as Video.VideoId));

			console.log(
				"[media-server-webhook] Deleted videoUploads for %s (transcription now unblocked)",
				payload.videoId,
			);

			if (currentUpload?.rawFileKey) {
				const rawFileKey = currentUpload.rawFileKey;
				Effect.gen(function* () {
					const bucketId = Option.fromNullable(
						currentVideo?.bucket ?? null,
					) as Option.Option<S3Bucket.S3BucketId>;
					const [bucket] = yield* S3Buckets.getBucketAccess(bucketId);
					yield* bucket.deleteObject(rawFileKey);
				})
					.pipe(runPromise)
					.then(() => {
						console.log(
							"[media-server-webhook] Cleaned up raw file %s for %s",
							rawFileKey,
							payload.videoId,
						);
					})
					.catch((err) => {
						console.warn(
							"[media-server-webhook] Failed to clean up raw file for %s:",
							payload.videoId,
							err,
						);
					});
			}
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
