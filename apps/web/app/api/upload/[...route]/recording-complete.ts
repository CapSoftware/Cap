import { db } from "@cap/database";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import { S3Bucket, Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq, notInArray } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { runPromise } from "@/lib/server";
import { withAuth } from "../../utils";

export const app = new Hono().post(
	"/",
	withAuth,
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { videoId: videoIdRaw } = c.req.valid("json");
		const videoId = Video.VideoId.make(videoIdRaw);

		const [video] = await db()
			.select()
			.from(Db.videos)
			.where(and(eq(Db.videos.id, videoId), eq(Db.videos.ownerId, user.id)));

		if (!video) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (video.source?.type !== "desktopSegments") {
			return c.json({ error: "Video is not a segmented recording" }, 400);
		}

		const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
		if (!mediaServerUrl) {
			await db()
				.update(Db.videos)
				.set({ source: { type: "desktopMP4" as const } })
				.where(eq(Db.videos.id, videoId));

			await db()
				.delete(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, videoId));

			return c.json({ success: true });
		}

		try {
			const muxPayload = await Effect.gen(function* () {
				const bucketId = Option.fromNullable(video.bucket).pipe(
					Option.map(S3Bucket.S3BucketId.make),
				);
				const [bucket] = yield* S3Buckets.getBucketAccess(bucketId);

				const segSource = new Video.SegmentsSource({
					videoId: videoIdRaw,
					ownerId: user.id,
				});

				const manifestContent = yield* bucket
					.getObject(segSource.getManifestKey())
					.pipe(
						Effect.andThen(
							Option.match({
								onNone: () =>
									Effect.fail(new Error("Segment manifest not found on S3")),
								onSome: (c) => Effect.succeed(c),
							}),
						),
					);

				let parsed: unknown;
				try {
					parsed = JSON.parse(manifestContent);
				} catch {
					return yield* Effect.fail(new Error("Invalid segment manifest JSON"));
				}

				const manifest = yield* Schema.decodeUnknown(Video.SegmentManifest)(
					parsed,
				).pipe(
					Effect.mapError(() => new Error("Invalid segment manifest format")),
				);

				if (!manifest.is_complete) {
					return yield* Effect.fail(
						new Error("Segment manifest is not marked as complete"),
					);
				}

				if (
					!manifest.video_init_uploaded ||
					manifest.video_segments.length === 0
				) {
					return yield* Effect.fail(
						new Error("No video segments found in manifest"),
					);
				}

				const videoInitUrl = yield* bucket.getSignedObjectUrl(
					segSource.getVideoInitKey(),
				);

				const videoSegmentUrls = yield* Effect.all(
					manifest.video_segments.map((seg) => {
						const entry = Video.normalizeSegmentEntry(seg);
						return bucket.getSignedObjectUrl(
							segSource.getVideoSegmentKey(entry.index),
						);
					}),
					{ concurrency: "unbounded" },
				);

				let audioInitUrl: string | undefined;
				let audioSegmentUrls: string[] | undefined;

				if (
					manifest.audio_init_uploaded &&
					manifest.audio_segments.length > 0
				) {
					audioInitUrl = yield* bucket.getSignedObjectUrl(
						segSource.getAudioInitKey(),
					);
					audioSegmentUrls = yield* Effect.all(
						manifest.audio_segments.map((seg) => {
							const entry = Video.normalizeSegmentEntry(seg);
							return bucket.getSignedObjectUrl(
								segSource.getAudioSegmentKey(entry.index),
							);
						}),
						{ concurrency: "unbounded" },
					);
				}

				const outputKey = `${user.id}/${videoIdRaw}/result.mp4`;
				const thumbnailKey = `${user.id}/${videoIdRaw}/screenshot/screen-capture.jpg`;

				const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
					outputKey,
					{
						ContentType: "video/mp4",
					},
				);
				const thumbnailPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
					thumbnailKey,
					{
						ContentType: "image/jpeg",
					},
				);

				return {
					outputPresignedUrl,
					thumbnailPresignedUrl,
					videoInitUrl,
					videoSegmentUrls,
					audioInitUrl,
					audioSegmentUrls,
				};
			}).pipe(runPromise);

			const claimResult = await db()
				.update(Db.videoUploads)
				.set({
					phase: "processing",
					processingProgress: 0,
					processingMessage: "Muxing segments into MP4...",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(Db.videoUploads.videoId, videoId),
						notInArray(Db.videoUploads.phase, [
							"processing",
							"generating_thumbnail",
						]),
					),
				);

			if (claimResult[0].affectedRows === 0) {
				const [existing] = await db()
					.select({ phase: Db.videoUploads.phase })
					.from(Db.videoUploads)
					.where(eq(Db.videoUploads.videoId, videoId));

				if (existing) {
					return c.json({ error: "Muxing already in progress" }, 409);
				}

				try {
					await db().insert(Db.videoUploads).values({
						videoId,
						phase: "processing",
						processingProgress: 0,
						processingMessage: "Muxing segments into MP4...",
					});
				} catch {
					return c.json({ error: "Muxing already in progress" }, 409);
				}
			}

			const webhookBaseUrl =
				serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
			const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress`;
			const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

			const muxBody: Record<string, unknown> = {
				videoId: videoIdRaw,
				userId: user.id,
				outputPresignedUrl: muxPayload.outputPresignedUrl,
				thumbnailPresignedUrl: muxPayload.thumbnailPresignedUrl,
				videoInitUrl: muxPayload.videoInitUrl,
				videoSegmentUrls: muxPayload.videoSegmentUrls,
				audioInitUrl: muxPayload.audioInitUrl,
				audioSegmentUrls: muxPayload.audioSegmentUrls,
				webhookUrl,
				webhookSecret: webhookSecret || undefined,
			};

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (webhookSecret) {
				headers["x-media-server-secret"] = webhookSecret;
			}

			const response = await fetch(`${mediaServerUrl}/video/mux-segments`, {
				method: "POST",
				headers,
				body: JSON.stringify(muxBody),
				signal: AbortSignal.timeout(30_000),
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				console.error(
					`[recording-complete] Media server mux-segments failed: ${response.status} ${errorText}`,
				);

				await db()
					.update(Db.videoUploads)
					.set({
						phase: "error",
						processingError: `Mux failed: ${response.status}`,
						updatedAt: new Date(),
					})
					.where(eq(Db.videoUploads.videoId, videoId));

				return c.json(
					{ error: "Failed to start muxing", details: errorText },
					502,
				);
			}

			const result = (await response.json()) as { jobId: string };

			return c.json({ success: true, jobId: result.jobId });
		} catch (error) {
			console.error("[recording-complete] Error triggering mux:", error);

			await db()
				.update(Db.videoUploads)
				.set({
					phase: "error",
					processingError:
						error instanceof Error ? error.message : "Unknown error",
					updatedAt: new Date(),
				})
				.where(eq(Db.videoUploads.videoId, videoId));

			return c.json({ error: "Internal server error" }, 500);
		}
	},
);
