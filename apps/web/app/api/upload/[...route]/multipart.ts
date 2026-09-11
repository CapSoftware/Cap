import { updateIfDefined } from "@cap/database";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import {
	Database,
	makeCurrentUserLayer,
	provideOptionalAuth,
	Storage,
	VideosPolicy,
} from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schedule } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import {
	invalidateReuploadedVideo,
	prepareDesktopReupload,
} from "@/lib/desktop-reupload";
import {
	assertDesktopReuploadTarget,
	createDesktopReuploadKey,
	createDesktopReuploadToken,
	decodeDesktopReuploadToken,
} from "@/lib/desktop-reupload-token";
import { invalidateGoogleDriveStorageQuotaCache } from "@/lib/google-drive-storage-quota";
import {
	queueVideoTranscription,
	shouldQueueTranscriptionAfterMultipartComplete,
} from "@/lib/queue-video-transcription";
import { runPromise } from "@/lib/server";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { stringOrNumberOptional } from "@/utils/zod";
import {
	getMultipartFileKey,
	getSubpath,
	isRawRecorderUpload,
} from "./multipart-utils";

export const app = new Hono().use(withAuth);

const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;
// Clients stop at the cap and then finalize, so reported durations can land
// slightly past the limit for honest recordings.
const FREE_PLAN_DURATION_GRACE_SECONDS = 30;

const runPromiseAnyEnv = runPromise as <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Promise<A>;

const abortRequestSchema = z
	.object({
		uploadId: z.string(),
	})
	.and(
		z.union([
			z.object({ videoId: z.string(), subpath: z.string().optional() }),
			// deprecated
			z.object({ fileKey: z.string() }),
		]),
	);

type AbortRequestInput = z.input<typeof abortRequestSchema>;

type AbortValidatorInput = {
	in: { json: AbortRequestInput };
	out: { json: z.output<typeof abortRequestSchema> };
};

const abortRequestValidator = zValidator(
	"json",
	abortRequestSchema,
) as MiddlewareHandler<Record<string, never>, "/abort", AbortValidatorInput>;

app.post(
	"/initiate",
	zValidator(
		"json",
		z
			.object({
				contentType: z.string(),
				replaceExisting: z.boolean().optional(),
			})
			.and(
				z.union([
					z.object({ videoId: z.string(), subpath: z.string().optional() }),
					// deprecated
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	async (c) => {
		const { contentType, replaceExisting, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = getMultipartFileKey(user.id, body);

		const videoIdFromFileKey = fileKey.split("/")[1];
		const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
		if (!videoIdRaw) return c.text("Video id not found", 400);
		const videoId = Video.VideoId.make(videoIdRaw);

		if (replaceExisting) {
			if ((getSubpath(body) ?? "result.mp4") !== "result.mp4") {
				return c.json(
					{ error: "Replacement uploads must target a recording" },
					400,
				);
			}
			return Effect.gen(function* () {
				const policy = yield* VideosPolicy;
				const db = yield* Database;
				const owned = yield* policy.getOwnedById(videoId);
				if (Option.isNone(owned))
					return c.json({ error: "Video not found" }, 404);
				const [video] = owned.value;
				const [bucket] = yield* Storage.getAccessForVideo(video, {
					resolvePublishedOutput: false,
				});
				const outputKey = createDesktopReuploadKey(video);
				const result = yield* bucket.multipart.create(outputKey, {
					ContentType: contentType || "video/mp4",
					CacheControl: "public, max-age=31536000, immutable",
					Metadata: { userId: user.id, source: "cap-desktop-reupload" },
				});
				if (!result.UploadId)
					return yield* Effect.fail(new Error("No upload ID returned"));
				const backendUploadId = result.UploadId;
				const uploadId = yield* Effect.gen(function* () {
					const token = yield* Effect.try(() =>
						createDesktopReuploadToken(video, {
							uploadId: backendUploadId,
							provider: bucket.provider,
							outputKey,
						}),
					);
					const state = {
						mode: "multipart" as const,
						rawFileKey: outputKey,
						uploaded: 0,
						total: 0,
						phase: "uploading" as const,
						processingProgress: 0,
						processingMessage: null,
						processingError: null,
						startedAt: new Date(),
						updatedAt: new Date(),
					};
					yield* db.use((db) =>
						db
							.insert(Db.videoUploads)
							.values({ videoId, ...state })
							.onDuplicateKeyUpdate({ set: state }),
					);
					return token;
				}).pipe(
					Effect.onError(() =>
						bucket.multipart
							.abort(outputKey, backendUploadId)
							.pipe(Effect.ignore),
					),
				);
				return c.json({ uploadId, provider: bucket.provider });
			}).pipe(
				Effect.catchAll(() =>
					Effect.succeed(
						c.json({ error: "Could not initiate replacement upload" }, 500),
					),
				),
				Effect.provide(makeCurrentUserLayer(user)),
				provideOptionalAuth,
				runPromiseAnyEnv,
			);
		}

		const resp = await Effect.gen(function* () {
			const policy = yield* VideosPolicy;
			const db = yield* Database;

			const video = yield* policy.getOwnedById(videoId);
			if (Option.isNone(video)) return yield* new Video.NotFoundError();

			yield* db.use((db) =>
				db
					.insert(Db.videoUploads)
					.values({
						videoId: video.value[0].id,
						mode: "multipart",
					})
					.onDuplicateKeyUpdate({
						set: {
							mode: "multipart",
							rawFileKey: null,
							updatedAt: new Date(),
						},
					}),
			);
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchAll((e) => {
				if (e._tag === "VideoNotFoundError")
					return Effect.succeed<Response>(c.text("Video not found", 404));

				return Effect.succeed<Response>(
					c.json({ error: "Error initiating multipart upload" }, 500),
				);
			}),
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
		if (resp) return resp;

		try {
			try {
				const uploadId = await Effect.gen(function* () {
					const policy = yield* VideosPolicy;
					const maybeVideo = yield* policy.getOwnedById(videoId);
					if (Option.isNone(maybeVideo)) {
						return yield* new Video.NotFoundError();
					}
					const [video] = maybeVideo.value;
					const [bucket] = yield* Storage.getAccessForVideo(video);

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

					return { uploadId: UploadId, provider: bucket.provider };
				}).pipe(
					Effect.provide(makeCurrentUserLayer(user)),
					provideOptionalAuth,
					runPromiseAnyEnv,
				);

				return c.json(uploadId);
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
					z.object({ videoId: z.string(), subpath: z.string().optional() }),
					// deprecated
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	async (c) => {
		const { uploadId, partNumber, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = getMultipartFileKey(user.id, body);

		try {
			try {
				const presignedUrl = await Effect.gen(function* () {
					const videoIdFromFileKey = fileKey.split("/")[1];
					const videoIdRaw =
						"videoId" in body ? body.videoId : videoIdFromFileKey;
					if (!videoIdRaw) throw new Error("Video id not found");
					const videoId = Video.VideoId.make(videoIdRaw);
					const policy = yield* VideosPolicy;
					const maybeVideo = yield* policy.getOwnedById(videoId);
					if (Option.isNone(maybeVideo)) {
						return yield* new Video.NotFoundError();
					}
					const [video] = maybeVideo.value;
					const replacement = yield* Effect.try(() =>
						decodeDesktopReuploadToken(uploadId),
					);
					const [bucket] = yield* replacement
						? Storage.getAccessForVideo(video, {
								resolvePublishedOutput: false,
							})
						: Storage.getAccessForVideo(video);
					if (replacement) {
						yield* Effect.try(() =>
							assertDesktopReuploadTarget(
								replacement,
								video,
								fileKey,
								bucket.provider,
							),
						);
						yield* Effect.try(() => {
							if (video.source.outputKey === replacement.outputKey) {
								throw new Error("Replacement upload is already complete");
							}
						});
					}

					console.log(`Getting presigned URL for multipart part ${partNumber}`);

					const presignedUrl =
						yield* bucket.multipart.getPresignedUploadPartUrl(
							replacement?.outputKey ?? fileKey,
							replacement?.uploadId ?? uploadId,
							partNumber,
							{ ContentMD5: body.md5Sum },
						);

					return { presignedUrl, provider: bucket.provider };
				}).pipe(
					Effect.catchTag("VideoNotFoundError", () =>
						Effect.succeed(
							c.json(
								{ error: "Video not found", code: "VIDEO_NOT_FOUND" },
								404,
							),
						),
					),
					Effect.catchTag("PolicyDenied", () =>
						Effect.succeed(
							c.json(
								{ error: "Video not found", code: "VIDEO_NOT_FOUND" },
								404,
							),
						),
					),
					Effect.provide(makeCurrentUserLayer(user)),
					provideOptionalAuth,
					runPromiseAnyEnv,
				);

				return presignedUrl instanceof Response
					? presignedUrl
					: c.json(presignedUrl);
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
				replaceExisting: z.boolean().optional(),
			})
			.and(
				z.union([
					z.object({ videoId: z.string(), subpath: z.string().optional() }),
					// deprecated
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	(c) => {
		const { uploadId, parts, ...body } = c.req.valid("json");
		const user = c.get("user");

		return Effect.gen(function* () {
			const policy = yield* VideosPolicy;
			const db = yield* Database;

			const fileKey = getMultipartFileKey(user.id, body);
			const subpath = getSubpath(body) ?? "result.mp4";
			const replacesVideo =
				body.replaceExisting === true && subpath === "result.mp4";

			const videoIdFromFileKey = fileKey.split("/")[1];
			const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
			if (!videoIdRaw) return c.text("Video id not found", 400);
			const videoId = Video.VideoId.make(videoIdRaw);

			const maybeVideo = yield* policy.getOwnedById(videoId);
			if (Option.isNone(maybeVideo)) {
				c.status(404);
				return c.text(`Video '${encodeURIComponent(videoId)}' not found`);
			}
			const [video] = maybeVideo.value;
			const replacement = yield* Effect.try(() =>
				decodeDesktopReuploadToken(uploadId),
			);
			if (replacesVideo && !replacement) {
				return c.json(
					{
						error:
							"Restart this replacement upload to preserve the existing recording",
						code: "REPLACEMENT_RESTART_REQUIRED",
					},
					409,
				);
			}

			// Server-side backstop for the free-plan recording cap. First-party
			// recorders always report durationInSecs and self-stop at the limit
			// (the grace covers stop/finalize latency). For free-plan orgs a raw
			// recorder upload must report a duration, and any reported duration
			// over the limit is rejected regardless of subpath — renaming the
			// subpath alone does not skip the gate. The duration is still
			// client-reported — a tampered client can understate it, or omit it
			// on a non-raw subpath — so this raises the bar rather than
			// enforcing authoritatively; that would require measuring the media
			// server-side during processing. Gated on the org owner's plan to
			// match the recorder bootstrap.
			const reportedDuration =
				typeof body.durationInSecs === "number" ? body.durationInSecs : null;
			const missingRequiredDuration =
				isRawRecorderUpload(subpath) && reportedDuration === null;
			const exceedsFreePlanLimit =
				reportedDuration !== null &&
				reportedDuration >
					Video.FREE_PLAN_MAX_RECORDING_SECONDS +
						FREE_PLAN_DURATION_GRACE_SECONDS;

			if (missingRequiredDuration || exceedsFreePlanLimit) {
				const [orgOwner] = yield* db.use((db) =>
					db
						.select({
							stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
							thirdPartyStripeSubscriptionId:
								Db.users.thirdPartyStripeSubscriptionId,
						})
						.from(Db.organizations)
						.innerJoin(Db.users, eq(Db.organizations.ownerId, Db.users.id))
						.where(eq(Db.organizations.id, video.orgId))
						.limit(1),
				);

				if (!userIsPro(orgOwner)) {
					// The uploaded parts must not linger as incomplete-MPU storage
					// (S3 bills them until the upload is aborted), and the stale
					// videoUploads row would otherwise keep the video in a phantom
					// "uploading" state. Cleanup is best-effort: the 403 stands
					// either way.
					yield* Effect.gen(function* () {
						const [bucket] = yield* Storage.getAccessForVideo(
							video,
							replacement ? { resolvePublishedOutput: false } : undefined,
						);
						if (replacement) {
							yield* Effect.try(() =>
								assertDesktopReuploadTarget(
									replacement,
									video,
									fileKey,
									bucket.provider,
								),
							);
							yield* db.use((db) =>
								db
									.delete(Db.videoUploads)
									.where(
										and(
											eq(Db.videoUploads.videoId, videoId),
											eq(Db.videoUploads.rawFileKey, replacement.outputKey),
										),
									),
							);
							if (bucket.provider === "s3")
								yield* bucket.multipart.abort(
									replacement.outputKey,
									replacement.uploadId,
								);
						} else {
							yield* bucket.multipart.abort(fileKey, uploadId);
							yield* db.use((db) =>
								db
									.delete(Db.videoUploads)
									.where(eq(Db.videoUploads.videoId, videoId)),
							);
						}
					}).pipe(
						Effect.catchAll(() =>
							Effect.logError(
								"Failed to clean up rejected free-plan multipart upload",
							),
						),
					);

					c.status(403);
					return c.text(
						reportedDuration === null
							? "Recording duration is required to complete a free plan upload."
							: "Recording exceeds the free plan duration limit. Upgrade to Cap Pro to upload longer recordings.",
					);
				}
			}

			if (replacement) {
				return yield* Effect.gen(function* () {
					yield* Effect.try(() =>
						assertDesktopReuploadTarget(replacement, video, fileKey),
					);
					const [bucket] = yield* Storage.getAccessForVideo(video, {
						resolvePublishedOutput: false,
					});
					yield* Effect.try(() =>
						assertDesktopReuploadTarget(
							replacement,
							video,
							fileKey,
							bucket.provider,
						),
					);
					const outputKey = replacement.outputKey;
					const totalSize = parts.reduce((total, part) => total + part.size, 0);
					const verify = bucket.headObject(outputKey).pipe(
						Effect.filterOrFail(
							(head) => totalSize > 0 && head.ContentLength === totalSize,
							() => new Error("Replacement video could not be verified"),
						),
					);
					if (video.source.outputKey === outputKey) {
						const head = yield* verify;
						return c.json({
							success: true,
							fileKey: outputKey,
							objectIdentity: head.ETag,
						});
					}
					yield* bucket.multipart
						.complete(outputKey, replacement.uploadId, {
							MultipartUpload: {
								Parts: [...parts]
									.sort((a, b) => a.partNumber - b.partNumber)
									.map((part) => ({
										PartNumber: part.partNumber,
										ETag: part.etag,
									})),
							},
							...(bucket.provider === "googleDrive"
								? { MpuObjectSize: totalSize }
								: {}),
						})
						.pipe(
							Effect.catchAll((error) =>
								verify.pipe(Effect.catchAll(() => Effect.fail(error))),
							),
						);
					const head = yield* verify;
					yield* db.use((db) =>
						db.transaction(async (tx) => {
							const publication = await prepareDesktopReupload(
								tx,
								video,
								replacement,
							);
							if (!publication) return;
							await tx
								.update(Db.videos)
								.set({
									...publication,
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
										eq(Db.videos.id, videoId),
										eq(Db.videos.ownerId, user.id),
									),
								);
							await tx
								.delete(Db.videoUploads)
								.where(
									and(
										eq(Db.videoUploads.videoId, videoId),
										eq(Db.videoUploads.rawFileKey, outputKey),
									),
								);
						}),
					);
					yield* Effect.tryPromise(() =>
						invalidateGoogleDriveStorageQuotaCache(
							Option.getOrNull(video.storageIntegrationId),
						),
					).pipe(Effect.catchAll(Effect.logWarning));
					yield* Effect.tryPromise(() => invalidateReuploadedVideo(video)).pipe(
						Effect.catchAll((error) =>
							Effect.logWarning(
								"Could not refresh derived recording assets; playback uses the new immutable output",
								error,
							),
						),
					);
					if (
						shouldQueueTranscriptionAfterMultipartComplete(
							video.source.type,
							false,
						)
					) {
						yield* Effect.tryPromise(() =>
							queueVideoTranscription(videoId),
						).pipe(Effect.catchAll(Effect.logWarning));
					}
					return c.json({
						success: true,
						fileKey: outputKey,
						objectIdentity: head.ETag,
					});
				}).pipe(
					Effect.catchAll(() =>
						Effect.succeed(
							c.json({ error: "Could not publish replacement recording" }, 500),
						),
					),
				);
			}

			return yield* Effect.gen(function* () {
				const [bucket] = yield* Storage.getAccessForVideo(video, {
					resolvePublishedOutput: false,
				});

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
						...(bucket.provider === "googleDrive"
							? { MpuObjectSize: totalSize }
							: {}),
					});
					yield* Effect.promise(() =>
						invalidateGoogleDriveStorageQuotaCache(
							Option.getOrNull(video.storageIntegrationId),
						),
					);

					return { result, formattedParts };
				});

				return yield* Effect.gen(function* () {
					let objectIdentity = result.ETag;
					console.log(
						`Multipart upload completed successfully: ${
							result.Location || "no location"
						}`,
					);
					console.log(`Complete response: ${JSON.stringify(result, null, 2)}`);

					yield* bucket.headObject(fileKey).pipe(
						Effect.tap((head) =>
							replacesVideo &&
							(!head.ContentLength ||
								(result.ETag && head.ETag !== result.ETag))
								? Effect.fail(
										new Error("Reuploaded video could not be verified"),
									)
								: Effect.void,
						),
						Effect.tap((headResult) =>
							Effect.log(
								`Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`,
							),
						),
						Effect.retry({
							times: 3,
							schedule: Schedule.exponential("50 millis"),
						}),
						Effect.catchAll((headError) =>
							replacesVideo
								? Effect.fail(headError)
								: Effect.logError(
										`Warning: Unable to verify object: ${headError}`,
									),
						),
					);

					if (isRawRecorderUpload(subpath)) {
						yield* db.use((db) =>
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
						);

						const processingStarted = yield* Effect.tryPromise(() =>
							startVideoProcessingWorkflow({
								videoId: Video.VideoId.make(videoId),
								userId: user.id,
								rawFileKey: fileKey,
								bucketId: Option.getOrNull(video.bucketId),
								processingMessage: "Starting video processing...",
								startFailureMessage:
									"Video uploaded, but processing could not start.",
								mode: "multipart",
							}),
						).pipe(
							Effect.map(() => true),
							Effect.catchAll((error) =>
								Effect.logError(
									"Failed to start video processing workflow after raw upload completion",
									error,
								).pipe(Effect.map(() => false)),
							),
						);

						return c.json({
							location: result.Location,
							objectIdentity,
							success: true,
							fileKey,
							processingStarted,
						});
					}

					if (bucket.provider === "s3") {
						console.log(
							"Performing metadata fix by copying the object to itself...",
						);

						yield* bucket
							.copyObject(`${bucket.bucketName}/${fileKey}`, fileKey, {
								ContentType: "video/mp4",
								MetadataDirective: "REPLACE",
								...(result.ETag ? { CopySourceIfMatch: result.ETag } : {}),
							})
							.pipe(
								Effect.tap((copyResult) => {
									objectIdentity = copyResult.CopyObjectResult?.ETag;
									return Effect.log(
										"Copy for metadata fix successful:",
										copyResult,
									);
								}),
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
					}

					yield* db.use((db) =>
						db.transaction(async (tx) => {
							await tx
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
								);
							await tx
								.delete(Db.videoUploads)
								.where(
									eq(Db.videoUploads.videoId, Video.VideoId.make(videoId)),
								);
						}),
					);

					const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
					let mediaProcessingPending = false;
					if (
						bucket.provider === "s3" &&
						video.source.type === "webMP4" &&
						mediaServerUrl
					) {
						const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
						const inputUrl = yield* bucket.getInternalSignedObjectUrl(fileKey, {
							expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
						});
						const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
							fileKey,
							{
								ContentType: "video/mp4",
								CacheControl: "max-age=31536000",
								Metadata: {
									userId: user.id,
									source: "cap-multipart-upload",
								},
							},
							{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
						);
						const previewGifKey = `${user.id}/${videoId}/preview/animated-preview.gif`;
						const previewGifPresignedUrl =
							yield* bucket.getInternalPresignedPutUrl(
								previewGifKey,
								{
									ContentType: "image/gif",
									CacheControl: "public, max-age=31536000, immutable",
								},
								{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
							);

						mediaProcessingPending = yield* Effect.tryPromise({
							try: async () => {
								const response = await fetch(
									`${mediaServerUrl}/video/process`,
									{
										method: "POST",
										headers: {
											"Content-Type": "application/json",
											...(webhookSecret
												? { "x-media-server-secret": webhookSecret }
												: {}),
										},
										body: JSON.stringify({
											videoId,
											userId: user.id,
											videoUrl: inputUrl,
											outputPresignedUrl,
											previewGifPresignedUrl,
											remuxOnly: true,
										}),
									},
								);

								if (!response.ok) {
									const errorText = await response.text().catch(() => "");
									throw new Error(
										`Media server remux failed: ${response.status} ${errorText}`,
									);
								}

								return true;
							},
							catch: (cause) =>
								cause instanceof Error ? cause : new Error(String(cause)),
						}).pipe(
							Effect.catchAll((error) => {
								console.error("Failed to queue faststart remux:", error);
								return Effect.succeed(false);
							}),
						);
					}

					if (
						shouldQueueTranscriptionAfterMultipartComplete(
							video.source.type,
							mediaProcessingPending,
						)
					) {
						yield* Effect.tryPromise(() =>
							queueVideoTranscription(Video.VideoId.make(videoId)),
						).pipe(
							Effect.tap((result) =>
								result.success
									? Effect.succeed(undefined)
									: Effect.logWarning(
											"Failed to queue transcription after multipart upload",
											{ videoId, message: result.message },
										),
							),
							Effect.catchAll((error) =>
								Effect.logWarning(
									"Failed to queue transcription after multipart upload",
									{ videoId, error },
								),
							),
						);
					}

					return c.json({
						location: result.Location,
						objectIdentity,
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
		}).pipe(
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
	},
);

app.post("/abort", abortRequestValidator, (c) => {
	const { uploadId, ...body } = c.req.valid("json");
	const user = c.get("user");

	const fileKey = getMultipartFileKey(user.id, body);

	const videoIdFromFileKey = fileKey.split("/")[1];
	const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
	if (!videoIdRaw) return c.text("Video id not found", 400);
	const videoId = Video.VideoId.make(videoIdRaw);

	return Effect.gen(function* () {
		const policy = yield* VideosPolicy;
		const db = yield* Database;

		const maybeVideo = yield* policy.getOwnedById(videoId);
		if (Option.isNone(maybeVideo)) {
			c.status(404);
			return c.text(`Video '${encodeURIComponent(videoId)}' not found`);
		}
		const [video] = maybeVideo.value;

		const replacement = yield* Effect.try(() =>
			decodeDesktopReuploadToken(uploadId),
		);
		if (replacement) {
			yield* Effect.try(() =>
				assertDesktopReuploadTarget(replacement, video, fileKey),
			);
			if (video.source.outputKey === replacement.outputKey) {
				return c.json({
					success: true,
					fileKey: replacement.outputKey,
					uploadId,
				});
			}
			const [bucket] = yield* Storage.getAccessForVideo(video, {
				resolvePublishedOutput: false,
			});
			yield* Effect.try(() =>
				assertDesktopReuploadTarget(
					replacement,
					video,
					fileKey,
					bucket.provider,
				),
			);

			yield* db.use((db) =>
				db
					.delete(Db.videoUploads)
					.where(
						and(
							eq(Db.videoUploads.videoId, videoId),
							eq(Db.videoUploads.rawFileKey, replacement.outputKey),
						),
					),
			);
			// Drive abort deletes the object mapping, which may already be used by a concurrent publication.
			if (bucket.provider === "s3") {
				yield* bucket.multipart
					.abort(replacement.outputKey, replacement.uploadId)
					.pipe(
						Effect.catchAll(() =>
							Effect.logWarning(
								"Could not abort canceled replacement storage upload",
							),
						),
					);
			}

			return c.json({
				success: true,
				fileKey: replacement.outputKey,
				uploadId,
			});
		}

		const [bucket] = yield* Storage.getAccessForVideo(video);

		console.log(`Aborting multipart upload ${uploadId} for key: ${fileKey}`);
		yield* bucket.multipart.abort(fileKey, uploadId);

		yield* db.use((db) =>
			db.delete(Db.videoUploads).where(eq(Db.videoUploads.videoId, videoId)),
		);

		return c.json({ success: true, fileKey, uploadId });
	}).pipe(
		Effect.catchAll((error) => {
			console.error("Failed to abort multipart upload:", error);

			return Effect.succeed(
				c.json(
					{
						error: "Failed to abort multipart upload",
						details: error instanceof Error ? error.message : String(error),
					},
					500,
				),
			);
		}),
		Effect.provide(makeCurrentUserLayer(user)),
		provideOptionalAuth,
		runPromiseAnyEnv,
	);
});
