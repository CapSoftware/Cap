import { db, updateIfDefined } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
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
			})
			.and(
				z.union([
					z.object({ videoId: z.string() }),
					// deprecated
					z.object({ fileKey: z.string() }),
					// deprecated
					// z.object({ md5Sum: z.string() }),
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
	async (c) => {
		const { uploadId, parts, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = parseVideoIdOrFileKey(user.id, {
			...body,
			subpath: "result.mp4",
		});

		try {
			try {
				const [bucket] = await S3Buckets.getBucketAccessForUser(user.id).pipe(
					runPromise,
				);

				const { result, formattedParts } = await Effect.gen(function* () {
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
				}).pipe(runPromise);

				try {
					console.log(
						`Multipart upload completed successfully: ${
							result.Location || "no location"
						}`,
					);
					console.log(`Complete response: ${JSON.stringify(result, null, 2)}`);

					await Effect.gen(function* () {
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
							);

						yield* bucket.headObject(fileKey).pipe(
							Effect.tap((headResult) =>
								Effect.log(
									`Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`,
								),
							),
							Effect.catchAll((headError) =>
								Effect.logError(
									`Warning: Unable to verify object: ${headError}`,
								),
							),
						);
					}).pipe(runPromise);

					const videoIdFromFileKey = fileKey.split("/")[1];

					const videoId = "videoId" in body ? body.videoId : videoIdFromFileKey;
					if (videoId) {
						const result = await db()
							.update(videos)
							.set({
								duration: updateIfDefined(body.durationInSecs, videos.duration),
								width: updateIfDefined(body.width, videos.width),
								height: updateIfDefined(body.height, videos.height),
								fps: updateIfDefined(body.fps, videos.fps),
							})
							.where(
								and(
									eq(videos.id, Video.VideoId.make(videoId)),
									eq(videos.ownerId, user.id),
								),
							);

						// This proves authentication
						if (result.rowsAffected > 0)
							await db()
								.delete(videoUploads)
								.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));
					}

					return c.json({
						location: result.Location,
						success: true,
						fileKey,
					});
				} catch (completeError) {
					console.error("Failed to complete multipart upload:", completeError);
					return c.json(
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
					);
				}
			} catch (s3Error) {
				console.error("S3 operation failed:", s3Error);
				throw new Error(
					`S3 operation failed: ${
						s3Error instanceof Error ? s3Error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			console.error("Error completing multipart upload", error);
			return c.json(
				{
					error: "Error completing multipart upload",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);
