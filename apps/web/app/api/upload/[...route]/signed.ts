import { db, updateIfDefined } from "@cap/database";
import * as Db from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import { isFromDesktopSemver, UPLOAD_PROGRESS_VERSION } from "@/utils/desktop";
import { stringOrNumberOptional } from "@/utils/zod";
import { withAuth } from "../../utils";
import { parseVideoIdOrFileKey } from "../utils";

const decodeVideo = (video: typeof Db.videos.$inferSelect) =>
	decodeStorageVideo(video);

function contentTypeForSubpath(subpath: string): string {
	if (subpath.endsWith(".json")) return "application/json";
	if (subpath.endsWith(".mp4") || subpath.endsWith(".m4s")) return "video/mp4";
	if (subpath.endsWith(".jpg") || subpath.endsWith(".jpeg"))
		return "image/jpeg";
	if (subpath.endsWith(".aac")) return "audio/aac";
	if (subpath.endsWith(".webm")) return "audio/webm";
	if (subpath.endsWith(".m3u8")) return "application/x-mpegURL";
	return "application/octet-stream";
}

export const app = new Hono().use(withAuth);

app.post(
	"/batch",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			subpaths: z
				.array(
					z
						.string()
						.refine(
							(s) => !s.includes("..") && !s.startsWith("/"),
							"Invalid subpath",
						),
				)
				.min(1)
				.max(50),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { videoId, subpaths } = c.req.valid("json");

		try {
			const [video] = await db()
				.select()
				.from(Db.videos)
				.where(eq(Db.videos.id, Video.VideoId.make(videoId)));

			if (!video) return c.json({ error: "Video not found" }, 404);
			if (video.ownerId !== user.id) return c.json({ error: "Forbidden" }, 403);
			const videoDomain = decodeVideo(video);

			const batch = await Effect.gen(function* () {
				const [bucket] = yield* Storage.getAccessForVideo(videoDomain);

				const entries = yield* Effect.all(
					subpaths.map((subpath) => {
						const fileKey = `${user.id}/${videoId}/${subpath}`;
						return bucket
							.createUploadTarget(fileKey, {
								contentType: contentTypeForSubpath(subpath),
								method: "put",
							})
							.pipe(Effect.map((upload) => [subpath, upload] as const));
					}),
					{ concurrency: "unbounded" },
				);

				const uploads = Object.fromEntries(entries);
				const urls = Object.fromEntries(
					entries.map(([subpath, upload]) => [subpath, upload.url]),
				);
				return { uploads, urls };
			}).pipe(runPromise);

			return c.json(batch);
		} catch (error) {
			console.error("Batch signed URL generation failed:", error);
			return c.json({ error: "Internal server error" }, 500);
		}
	},
);

app.post(
	"/",
	zValidator(
		"json",
		z
			.object({
				method: z.union([z.literal("post"), z.literal("put")]).default("post"),
				durationInSecs: stringOrNumberOptional,
				width: stringOrNumberOptional,
				height: stringOrNumberOptional,
				fps: stringOrNumberOptional,
			})
			.and(
				z.union([
					// DEPRECATED
					z.object({ fileKey: z.string() }),
					z.object({ videoId: z.string(), subpath: z.string() }),
				]),
			),
	),
	async (c) => {
		const user = c.get("user");
		const { durationInSecs, width, height, fps, method, ...body } =
			c.req.valid("json");

		const fileKey = parseVideoIdOrFileKey(user.id, body);
		const videoIdFromKey = fileKey.split("/")[1];
		const videoIdToUse = "videoId" in body ? body.videoId : videoIdFromKey;
		if (!videoIdToUse) return c.json({ error: "Video id not found" }, 400);

		try {
			const [video] = await db()
				.select()
				.from(Db.videos)
				.where(eq(Db.videos.id, Video.VideoId.make(videoIdToUse)));

			if (!video) return c.json({ error: "Video not found" }, 404);
			if (video.ownerId !== user.id) return c.json({ error: "Forbidden" }, 403);
			const videoDomain = decodeVideo(video);

			const contentType = fileKey.endsWith(".aac")
				? "audio/aac"
				: fileKey.endsWith(".webm")
					? "audio/webm"
					: fileKey.endsWith(".mp4")
						? "video/mp4"
						: fileKey.endsWith(".mp3")
							? "audio/mpeg"
							: fileKey.endsWith(".m3u8")
								? "application/x-mpegURL"
								: "video/mp2t";

			const data = await Effect.gen(function* () {
				const [bucket] = yield* Storage.getAccessForVideo(videoDomain);

				const Fields = {
					"x-amz-meta-userid": user.id,
					"x-amz-meta-duration": durationInSecs
						? durationInSecs.toString()
						: "",
				};

				return yield* bucket.createUploadTarget(fileKey, {
					contentType,
					fields: Fields,
					method,
				});
			}).pipe(runPromise);

			console.log("Presigned URL created successfully");

			if (videoIdToUse) {
				const videoId = Video.VideoId.make(videoIdToUse);
				await db()
					.update(Db.videos)
					.set({
						duration: updateIfDefined(durationInSecs, Db.videos.duration),
						width: updateIfDefined(width, Db.videos.width),
						height: updateIfDefined(height, Db.videos.height),
						fps: updateIfDefined(fps, Db.videos.fps),
					})
					.where(
						and(eq(Db.videos.id, videoId), eq(Db.videos.ownerId, user.id)),
					);

				const clientSupportsUploadProgress = isFromDesktopSemver(
					c.req,
					UPLOAD_PROGRESS_VERSION,
				);
				if (fileKey.endsWith("result.mp4") && clientSupportsUploadProgress)
					await db()
						.update(Db.videoUploads)
						.set({ mode: "singlepart" })
						.where(eq(Db.videoUploads.videoId, videoId));
			}

			if (data.type === "s3Post") {
				return c.json({
					presignedPostData: { url: data.url, fields: data.fields },
				});
			}
			return c.json({
				presignedPutData: {
					url: data.url,
					fields: {},
					headers: data.headers,
					type: data.type,
				},
			});
		} catch (s3Error) {
			console.error("S3 operation failed:", s3Error);
			throw new Error(
				`S3 operation failed: ${
					s3Error instanceof Error ? s3Error.message : "Unknown error"
				}`,
			);
		}
	},
);
