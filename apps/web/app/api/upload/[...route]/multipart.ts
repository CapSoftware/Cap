import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db, updateIfDefined } from "@cap/database";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	AwsCredentials,
	Database,
	provideOptionalAuth,
	S3Buckets,
	Videos,
} from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schedule } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import { runPromise } from "@/lib/server";
import { stringOrNumberOptional } from "@/utils/zod";
import { parseVideoIdOrFileKey } from "../utils";

export const app = new Hono().use(withAuth);

app.post(
	"/initiate",
	zValidator(
		"json",
		z.object({ contentType: z.string() }).and(
			z.union([
				z.object({ videoId: z.string() }),
				// deprecated
				z.object({ fileKey: z.string() }),
			]),
		),
	),
	async (c) => {
		const { contentType, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = parseVideoIdOrFileKey(user.id, {
			...body,
			subpath: "result.mp4",
		});

		const videoIdFromFileKey = fileKey.split("/")[1];
		const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
		if (!videoIdRaw) throw new Error("Video ID is required");
		const videoId = Video.VideoId.make(videoIdRaw);

		const resp = await Effect.gen(function* () {
			const videos = yield* Videos;
			const db = yield* Database;

			const video = yield* videos.getByIdForOwner(videoId);
			if (Option.isNone(video)) return yield* new Video.NotFoundError();

			yield* db.use((db) =>
				db
					.update(Db.videoUploads)
					.set({ mode: "multipart" })
					.where(eq(Db.videoUploads.videoId, video.value[0].id)),
			);
		}).pipe(
			provideOptionalAuth,
			Effect.tapError(Effect.logError),
			Effect.catchAll((e) => {
				if (e._tag === "VideoNotFoundError")
					return Effect.succeed<Response>(c.text("Video not found", 404));

				return Effect.succeed<Response>(
					c.json({ error: "Error initiating multipart upload" }, 500),
				);
			}),
			runPromise,
		);
		if (resp) return resp;

		try {
			try {
				const uploadId = await Effect.gen(function* () {
					const [bucket] = yield* S3Buckets.getBucketAccessForUser(user.id);

					const finalContentType = contentType || "video/mp4";
					console.log(
						`Creating multipart upload in bucket: ${bucket.bucketName}, content-type: ${finalContentType}, key: ${fileKey}`,
					);

					const { UploadId } = yield* bucket.multipart.create(fileKey, {
						ContentType: finalContentType,
						Metadata: {
							userId: user.id,
							source: "cap-multipart-upload",
						},
						CacheControl: "max-age=31536000",
					});

					if (!UploadId) {
						throw new Error("No UploadId returned from S3");
					}

					console.log(
						`Successfully initiated multipart upload with ID: ${UploadId}`,
					);
					console.log(
						`Upload details: Bucket=${bucket.bucketName}, Key=${fileKey}, ContentType=${finalContentType}`,
					);

					return UploadId;
				}).pipe(runPromise);

				return c.json({ uploadId: uploadId });
			} catch (s3Error) {
				console.error("S3 operation failed:", s3Error);
				throw new Error(
					`S3 operation failed: ${
						s3Error instanceof Error ? s3Error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			console.error("Error initiating multipart upload", error);
			return c.json(
				{
					error: "Error initiating multipart upload",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);

app.post(
	"/presign-part",
	zValidator(
		"json",
		z
			.object({
				uploadId: z.string(),
				partNumber: z.number(),
				// deprecated
				md5Sum: z.string().optional(),
			})
			.and(
				z.union([
					z.object({ videoId: z.string() }),
					// deprecated
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	async (c) => {
		const { uploadId, partNumber, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = parseVideoIdOrFileKey(user.id, {
			...body,
			subpath: "result.mp4",
		});

		try {
			try {
				const presignedUrl = await Effect.gen(function* () {
					const [bucket] = yield* S3Buckets.getBucketAccessForUser(user.id);

					console.log(
						`Getting presigned URL for part ${partNumber} of upload ${uploadId}`,
					);

					const presignedUrl =
						yield* bucket.multipart.getPresignedUploadPartUrl(
							fileKey,
							uploadId,
							partNumber,
							{ ContentMD5: body.md5Sum },
						);

					return presignedUrl;
				}).pipe(runPromise);

				return c.json({ presignedUrl });
			} catch (s3Error) {
				console.error("S3 operation failed:", s3Error);
				throw new Error(
					`S3 operation failed: ${
						s3Error instanceof Error ? s3Error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			console.error("Error creating presigned URL for part", error);
			return c.json(
				{
					error: "Error creating presigned URL for part",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);

app.post(
	"/complete",
	zValidator(
		"json",
		z
			.object({
				uploadId: z.string(),
				parts: z.array(
					z.object({
						partNumber: z.number(),
						etag: z.string(),
						size: z.number(),
					}),
				),
				durationInSecs: stringOrNumberOptional,
				width: stringOrNumberOptional,
				height: stringOrNumberOptional,
				fps: stringOrNumberOptional,
			})
			.and(
				z.union([
					z.object({ videoId: z.string() }),
					// deprecated
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	(c) =>
		Effect.gen(function* () {
			const videos = yield* Videos;
			const db = yield* Database;

			const { uploadId, parts, ...body } = c.req.valid("json");
			const user = c.get("user");

			const fileKey = parseVideoIdOrFileKey(user.id, {
				...body,
				subpath: "result.mp4",
			});

			const videoIdFromFileKey = fileKey.split("/")[1];
			const videoId = "videoId" in body ? body.videoId : videoIdFromFileKey;
			if (!videoId) throw new Error("Video ID is required");

			const maybeVideo = yield* videos.getById(Video.VideoId.make(videoId));
			if (Option.isNone(maybeVideo)) {
				c.status(404);
				return c.text(`Video '${encodeURIComponent(videoId)}' not found`);
			}
			const [video] = maybeVideo.value;

			return yield* Effect.gen(function* () {
				const [bucket, customBucket] = yield* S3Buckets.getBucketAccess(
					video.bucketId,
				);

				const { result, formattedParts } = yield* Effect.gen(function* () {
					console.log(
						`Completing multipart upload ${uploadId} with ${parts.length} parts for key: ${fileKey}`,
					);

					const totalSize = parts.reduce((acc, part) => acc + part.size, 0);
					console.log(`Total size of all parts: ${totalSize} bytes`);

					const sortedParts = [...parts].sort(
						(a, b) => a.partNumber - b.partNumber,
					);

					const sequentialCheck = sortedParts.every(
						(part, index) => part.partNumber === index + 1,
					);

					if (!sequentialCheck) {
						console.warn(
							"WARNING: Part numbers are not sequential! This may cause issues with the assembled file.",
						);
					}

					const formattedParts = sortedParts.map((part) => ({
						PartNumber: part.partNumber,
						ETag: part.etag,
					}));

					console.log(
						"Sending to S3:",
						JSON.stringify(
							{
								Bucket: bucket.bucketName,
								Key: fileKey,
								UploadId: uploadId,
								Parts: formattedParts,
							},
							null,
							2,
						),
					);

					const result = yield* bucket.multipart.complete(fileKey, uploadId, {
						MultipartUpload: {
							Parts: formattedParts,
						},
					});

					return { result, formattedParts };
				});

				return yield* Effect.gen(function* () {
					console.log(
						`Multipart upload completed successfully: ${
							result.Location || "no location"
						}`,
					);
					console.log(`Complete response: ${JSON.stringify(result, null, 2)}`);

					console.log(
						"Performing metadata fix by copying the object to itself...",
					);

					yield* bucket
						.copyObject(`${bucket.bucketName}/${fileKey}`, fileKey, {
							ContentType: "video/mp4",
							MetadataDirective: "REPLACE",
						})
						.pipe(
							Effect.tap((result) =>
								Effect.log("Copy for metadata fix successful:", result),
							),
							Effect.catchAll((e) =>
								Effect.logError(
									"Warning: Failed to copy object to fix metadata:",
									e,
								),
							),
							Effect.retry({
								times: 3,
								schedule: Schedule.exponential("50 millis"),
							}),
						);

					yield* bucket.headObject(fileKey).pipe(
						Effect.tap((headResult) =>
							Effect.log(
								`Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`,
							),
						),
						Effect.catchAll((headError) =>
							Effect.logError(`Warning: Unable to verify object: ${headError}`),
						),
						Effect.retry({
							times: 3,
							schedule: Schedule.exponential("50 millis"),
						}),
					);

					yield* db.use((db) =>
						db.transaction(() =>
							Promise.all([
								db
									.update(Db.videos)
									.set({
										duration: updateIfDefined(
											body.durationInSecs,
											Db.videos.duration,
										),
										width: updateIfDefined(body.width, Db.videos.width),
										height: updateIfDefined(body.height, Db.videos.height),
										fps: updateIfDefined(body.fps, Db.videos.fps),
									})
									.where(
										and(
											eq(Db.videos.id, Video.VideoId.make(videoId)),
											eq(Db.videos.ownerId, user.id),
										),
									),
								db
									.delete(Db.videoUploads)
									.where(
										eq(Db.videoUploads.videoId, Video.VideoId.make(videoId)),
									),
							]),
						),
					);

					if (Option.isNone(customBucket)) {
						const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
						if (distributionId) {
							const cloudfront = new CloudFrontClient({
								region: serverEnv().CAP_AWS_REGION || "us-east-1",
								credentials: yield* Effect.map(
									AwsCredentials,
									(c) => c.credentials,
								),
							});

							const pathToInvalidate = "/" + fileKey;

							yield* Effect.promise(() =>
								cloudfront.send(
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
								),
							).pipe(
								Effect.catchAll((e) =>
									Effect.logError(
										"Failed to create CloudFront invalidation:",
										e,
									),
								),
								Effect.withSpan("CloudFrontInvalidation"),
							);
						}
					}

					return c.json({
						location: result.Location,
						success: true,
						fileKey,
					});
				}).pipe(
					Effect.catchAllCause((completeError) => {
						console.error(
							"Failed to complete multipart upload:",
							completeError,
						);
						return Effect.succeed(
							c.json(
								{
									error: "Failed to complete multipart upload",
									details:
										completeError instanceof Error
											? completeError.message
											: String(completeError),
									uploadId,
									fileKey,
									parts: formattedParts.length,
								},
								500,
							),
						);
					}),
				);
			}).pipe(
				Effect.catchAll((error) => {
					console.error("Multipart upload failed:", error);

					return Effect.succeed(
						c.json(
							{
								error: "Error completing multipart upload",
								details: error instanceof Error ? error.message : String(error),
							},
							500,
						),
					);
				}),
			);
		}).pipe(provideOptionalAuth, runPromise),
);
