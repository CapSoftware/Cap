import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import type { PresignedPost } from "@aws-sdk/s3-presigned-post";
import { db, updateIfDefined } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { AwsCredentials, S3Buckets } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { runPromise } from "@/lib/server";
import { stringOrNumberOptional } from "@/utils/zod";
import { withAuth } from "../../utils";
import { parseVideoIdOrFileKey } from "../utils";

export const app = new Hono().use(withAuth);

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
				.from(s3Buckets)
				.where(eq(s3Buckets.ownerId, user.id));

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

					const pathToInvalidate = "/" + fileKey;

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
			if (videoIdToUse)
				await db()
					.update(videos)
					.set({
						duration: updateIfDefined(durationInSecs, videos.duration),
						width: updateIfDefined(width, videos.width),
						height: updateIfDefined(height, videos.height),
						fps: updateIfDefined(fps, videos.fps),
					})
					.where(
						and(
							eq(videos.id, Video.VideoId.make(videoIdToUse)),
							eq(videos.ownerId, user.id),
						),
					);

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
