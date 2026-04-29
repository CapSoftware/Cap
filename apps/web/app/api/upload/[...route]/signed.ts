import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import type { PresignedPost } from "@aws-sdk/s3-presigned-post";
import { db, updateIfDefined } from "@cap/database";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { AwsCredentials, S3Buckets } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { runPromise } from "@/lib/server";
import { isFromDesktopSemver, UPLOAD_PROGRESS_VERSION } from "@/utils/desktop";
import { stringOrNumberOptional } from "@/utils/zod";
import { withAuth } from "../../utils";
import { parseVideoIdOrFileKey } from "../utils";

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
			const [customBucket] = await db()
				.select()
				.from(Db.s3Buckets)
				.where(eq(Db.s3Buckets.ownerId, user.id));

			const urls = await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(
					Option.fromNullable(customBucket?.id),
				);

				const entries = yield* Effect.all(
					subpaths.map((subpath) => {
						const fileKey = `${user.id}/${videoId}/${subpath}`;
						return bucket
							.getPresignedPutUrl(
								fileKey,
								{ ContentType: contentTypeForSubpath(subpath) },
								{ expiresIn: 1800 },
							)
							.pipe(Effect.map((url) => [subpath, url] as const));
					}),
					{ concurrency: "unbounded" },
				);

				return Object.fromEntries(entries);
			}).pipe(runPromise);

			return c.json({ urls });
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

		try {
			const [customBucket] = await db()
				.select()
				.from(Db.s3Buckets)
				.where(eq(Db.s3Buckets.ownerId, user.id));

			const s3Config = customBucket
				? {
						endpoint: customBucket.endpoint || undefined,
						region: customBucket.region,
						accessKeyId: customBucket.accessKeyId,
						secretAccessKey: customBucket.secretAccessKey,
					}
				: null;

			if (
				!customBucket ||
				!s3Config ||
				customBucket.bucketName !== serverEnv().CAP_AWS_BUCKET
			) {
				const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
				if (distributionId) {
					console.log("Creating CloudFront invalidation for", fileKey);

					const cloudfront = new CloudFrontClient({
						region: serverEnv().CAP_AWS_REGION || "us-east-1",
						credentials: await runPromise(
							Effect.map(AwsCredentials, (c) => c.credentials),
						),
					});

					const pathToInvalidate = `/${fileKey}`;

					try {
						const invalidation = await cloudfront.send(
							new CreateInvalidationCommand({
								DistributionId: distributionId,
								InvalidationBatch: {
									CallerReference: `${Date.now()}`,
									Paths: {
										Quantity: 1,
										Items: [pathToInvalidate],
									},
								},
							}),
						);
						console.log("CloudFront invalidation created:", invalidation);
					} catch (error) {
						console.error("Failed to create CloudFront invalidation:", error);
					}
				}
			}

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

			let data: PresignedPost;

			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(
					Option.fromNullable(customBucket?.id),
				);

				if (method === "post") {
					const Fields = {
						"Content-Type": contentType,
						"x-amz-meta-userid": user.id,
						"x-amz-meta-duration": durationInSecs
							? durationInSecs.toString()
							: "",
					};

					data = yield* bucket.getPresignedPostUrl(fileKey, {
						Fields,
						Expires: 1800,
					});
				} else if (method === "put") {
					const presignedUrl = yield* bucket.getPresignedPutUrl(
						fileKey,
						{
							ContentType: contentType,
							Metadata: {
								userid: user.id,
								duration: durationInSecs ? durationInSecs.toString() : "",
							},
						},
						{ expiresIn: 1800 },
					);

					data = { url: presignedUrl, fields: {} };
				}
			}).pipe(runPromise);

			console.log("Presigned URL created successfully");

			// After successful presigned URL creation, trigger revalidation
			const videoIdFromKey = fileKey.split("/")[1]; // Assuming fileKey format is userId/videoId/...

			const videoIdToUse = "videoId" in body ? body.videoId : videoIdFromKey;
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

				// i hate this but it'll have to do
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

			if (method === "post") return c.json({ presignedPostData: data! });
			else return c.json({ presignedPutData: data! });
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
