import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import {
	createCommentMediaUploadToken,
	makeCurrentUserLayer,
	provideOptionalAuth,
	Storage,
	VideosPolicy,
	VideosRepo,
	verifyCommentMediaUploadToken,
} from "@cap/web-backend";
import { Comment, Policy, Video } from "@cap/web-domain";
import { and, eq, gt, inArray } from "drizzle-orm";
import { Effect, Option, Schedule } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import { commentMediaKeys } from "@/lib/comment-media";
import {
	MAX_MEDIA_OBJECT_BYTES,
	MAX_MEDIA_OBJECTS_PER_VIDEO,
	releaseCommentMediaBytes,
	reserveCommentMediaBytes,
	reserveCommentMediaObjects,
} from "@/lib/comment-media-quota";
import { canUseMediaComments } from "@/lib/media-comments";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { runPromise } from "@/lib/server";
import { stringOrNumberOptional } from "@/utils/zod";
import { zValidator } from "@/utils/zod-validator";

export const app = new Hono().use(withAuth);

const runPromiseAnyEnv = runPromise as <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Promise<A>;

// Storage-growth bounds. Uploads land in the video owner's (possibly BYO)
// bucket, so an unbounded viewer must not be able to fill it unattended:
// per-commenter comment-rate, per-video object count, a per-object multipart
// ceiling (single PUTs are capped at 5GB by S3 itself), and a per-commenter
// byte budget on each video.
const MAX_MEDIA_COMMENTS_PER_HOUR = 30;

app.post(
	"/initiate",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			kind: z.enum(["video", "audio"]),
			contentType: z.string(),
			mode: z.enum(["single", "multipart"]),
			withThumbnail: z.boolean().optional(),
			size: z.number().int().nonnegative().optional(),
			thumbnailSize: z.number().int().nonnegative().optional(),
		}),
	),
	async (c) => {
		const {
			videoId: videoIdRaw,
			kind,
			mode,
			size,
			thumbnailSize,
		} = c.req.valid("json");
		// Every upload is a single PUT signed for its declared size, so storage
		// rejects any other size. Without a size there is no thumbnail target
		// (it is optional) and no upload. Multipart uploads already in flight
		// can still finish through /presign-part and /complete.
		const withThumbnail =
			c.req.valid("json").withThumbnail === true &&
			thumbnailSize !== undefined &&
			thumbnailSize <= MAX_MEDIA_OBJECT_BYTES;
		if (mode !== "single" || size === undefined)
			return c.json({ error: "Missing upload size" }, 400);
		if (size > MAX_MEDIA_OBJECT_BYTES)
			return c.json({ error: "Recording is too large" }, 413);
		const user = c.get("user");
		const videoId = Video.VideoId.make(videoIdRaw);

		return Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const policy = yield* VideosPolicy;

			const maybeVideo = yield* repo
				.getById(videoId)
				.pipe(Policy.withPublicPolicy(policy.canView(videoId)));
			if (Option.isNone(maybeVideo)) return yield* new Video.NotFoundError();
			const [video] = maybeVideo.value;

			const allowed = yield* Effect.tryPromise(() =>
				canUseMediaComments(user, video),
			);
			if (allowed !== true) {
				c.status(403);
				return c.json({ error: "upgrade_required" });
			}

			const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
			const recent = yield* Effect.tryPromise(() =>
				db()
					.select({ id: Db.comments.id })
					.from(Db.comments)
					.where(
						and(
							eq(Db.comments.videoId, videoId),
							eq(Db.comments.authorId, user.id),
							inArray(Db.comments.type, ["video", "audio"]),
							gt(Db.comments.createdAt, oneHourAgo),
						),
					)
					.limit(MAX_MEDIA_COMMENTS_PER_HOUR),
			);
			if (recent.length >= MAX_MEDIA_COMMENTS_PER_HOUR) {
				c.status(429);
				return c.json({ error: "Too many media comments, slow down" });
			}

			const initiatesLimited = yield* Effect.promise(() =>
				isRateLimited(RATE_LIMIT_IDS.COMMENT_MEDIA_UPLOAD, {
					key: `comment-media-upload:${user.id}`,
					headers: c.req.raw.headers,
				}),
			);
			if (initiatesLimited) {
				c.status(429);
				return c.json({ error: "Too many media comments, slow down" });
			}

			const [bucket] = yield* Storage.getAccessForVideo(video);

			const commentId = Comment.CommentId.make(nanoId());
			const keys = commentMediaKeys({
				ownerId: video.ownerId,
				videoId: video.id,
				commentId,
				kind,
				contentType: c.req.valid("json").contentType,
				withThumbnail,
			});
			if (!keys) {
				c.status(415);
				return c.json({ error: "Unsupported content type" });
			}
			const { contentType, key, thumbnailKey } = keys;

			// The viewer's own byte budget goes first, so a viewer at their limit
			// cannot take the video's shared object slots. The charge is refunded
			// if the upload is refused or fails after this point.
			const directBytes = size + (thumbnailKey ? (thumbnailSize ?? 0) : 0);
			const chargedAt = new Date();
			const charge = {
				videoId: video.id,
				userId: user.id,
				bytes: directBytes,
				now: chargedAt,
			};
			const refund =
				directBytes > 0
					? Effect.tryPromise(() => releaseCommentMediaBytes(charge)).pipe(
							Effect.catchAll(Effect.logError),
						)
					: Effect.void;
			if (directBytes > 0) {
				const withinBudget = yield* Effect.tryPromise(() =>
					reserveCommentMediaBytes(charge),
				);
				if (!withinBudget) {
					c.status(413);
					return c.json({ error: "Recording is too large" });
				}
			}

			// The comment-row throttle above only counts finished comments; an
			// initiate-and-PUT loop that never creates rows would bypass it. The
			// object count under the comments prefix is the ground truth for bytes
			// actually landed in the owner's (possibly BYO) bucket. Uploads that
			// have not landed yet are counted through a reservation taken under a
			// row lock, so concurrent initiates cannot all pass the same snapshot.
			const reserved = yield* Effect.gen(function* () {
				const existingObjects = yield* bucket.listObjects({
					prefix: `${video.ownerId}/${video.id}/comments/`,
					maxKeys: MAX_MEDIA_OBJECTS_PER_VIDEO,
				});
				return yield* Effect.tryPromise(() =>
					reserveCommentMediaObjects({
						videoId: video.id,
						objects: thumbnailKey ? 2 : 1,
						storedObjects: existingObjects.Contents?.length ?? 0,
					}),
				);
			}).pipe(Effect.tapError(() => refund));
			if (!reserved) {
				yield* refund;
				c.status(429);
				return c.json({
					error: "This video has reached its media comment limit",
				});
			}

			// Drive rejects presigned POST, so upload targets are always PUT-style;
			// createUploadTarget returns the provider-appropriate target shape.
			const thumbnailUpload = thumbnailKey
				? yield* bucket
						.createUploadTarget(thumbnailKey, {
							contentType: "image/jpeg",
							method: "put",
							contentLength: thumbnailSize,
							enforceContentLength: true,
						})
						.pipe(Effect.tapError(() => refund))
				: null;

			const uploadToken = createCommentMediaUploadToken({
				userId: user.id,
				videoId: video.id,
				commentId,
				key,
				thumbnailKey,
				contentType,
				kind,
			});

			// Deliberately no Db.videoUploads row: that table drives the parent
			// video's "uploading" UI state and the stale-upload cron.
			const upload = yield* bucket
				.createUploadTarget(key, {
					contentType,
					method: "put",
					contentLength: size,
					enforceContentLength: true,
				})
				.pipe(Effect.tapError(() => refund));
			return c.json({ commentId, key, uploadToken, upload, thumbnailUpload });
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchAll((e) => {
				// PolicyDenied maps to 404, not 403: canView succeeds for nonexistent
				// ids by design, so a 403 here would confirm a private video exists.
				if (
					typeof e === "object" &&
					e !== null &&
					"_tag" in e &&
					(e._tag === "VideoNotFoundError" || e._tag === "PolicyDenied")
				)
					return Effect.succeed<Response>(
						c.json({ error: "Video not found" }, 404),
					);
				return Effect.succeed<Response>(
					c.json({ error: "Error initiating comment media upload" }, 500),
				);
			}),
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
	},
);

const verifiedClaims = (
	c: { get: (key: "user") => { id: string } },
	uploadToken: string,
) => {
	const claims = verifyCommentMediaUploadToken(uploadToken);
	if (!claims) return null;
	if (claims.userId !== c.get("user").id) return null;
	return claims;
};

app.post(
	"/presign-part",
	zValidator(
		"json",
		z.object({
			uploadToken: z.string(),
			uploadId: z.string(),
			partNumber: z.number(),
			// Tolerated and ignored: the shared recorder upload client includes
			// these in every request body.
			videoId: z.string().optional(),
			subpath: z.string().optional(),
			md5Sum: z.string().optional(),
		}),
	),
	async (c) => {
		const { uploadToken, uploadId, partNumber } = c.req.valid("json");
		const user = c.get("user");
		const claims = verifiedClaims(c, uploadToken);
		if (!claims) return c.json({ error: "Invalid upload token" }, 403);

		return Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const maybeVideo = yield* repo.getById(
				Video.VideoId.make(claims.videoId),
			);
			if (Option.isNone(maybeVideo)) return yield* new Video.NotFoundError();
			const [bucket] = yield* Storage.getAccessForVideo(maybeVideo.value[0]);

			const presignedUrl = yield* bucket.multipart.getPresignedUploadPartUrl(
				claims.key,
				uploadId,
				partNumber,
			);
			return c.json({ presignedUrl, provider: bucket.provider });
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchAll(() =>
				Effect.succeed<Response>(
					c.json({ error: "Error creating presigned URL for part" }, 500),
				),
			),
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
	},
);

app.post(
	"/complete",
	zValidator(
		"json",
		z.object({
			uploadToken: z.string(),
			uploadId: z.string(),
			parts: z.array(
				z.object({
					partNumber: z.number(),
					etag: z.string(),
					size: z.number(),
				}),
			),
			// Tolerated for client compatibility; media dimensions travel on the
			// comment row via the create action, not here.
			durationInSecs: stringOrNumberOptional,
			width: stringOrNumberOptional,
			height: stringOrNumberOptional,
			fps: stringOrNumberOptional,
			videoId: z.string().optional(),
			subpath: z.string().optional(),
		}),
	),
	async (c) => {
		const { uploadToken, uploadId, parts } = c.req.valid("json");
		const user = c.get("user");
		const claims = verifiedClaims(c, uploadToken);
		if (!claims) return c.json({ error: "Invalid upload token" }, 403);

		return Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const maybeVideo = yield* repo.getById(
				Video.VideoId.make(claims.videoId),
			);
			if (Option.isNone(maybeVideo)) return yield* new Video.NotFoundError();
			const [bucket] = yield* Storage.getAccessForVideo(maybeVideo.value[0]);

			const sortedParts = [...parts].sort(
				(a, b) => a.partNumber - b.partNumber,
			);
			const totalSize = sortedParts.reduce((acc, part) => acc + part.size, 0);

			if (totalSize > MAX_MEDIA_OBJECT_BYTES) {
				yield* bucket.multipart
					.abort(claims.key, uploadId)
					.pipe(Effect.catchAll(Effect.logError));
				c.status(413);
				return c.json({ error: "Recording is too large" });
			}

			yield* bucket.multipart.complete(claims.key, uploadId, {
				MultipartUpload: {
					Parts: sortedParts.map((part) => ({
						PartNumber: part.partNumber,
						ETag: part.etag,
					})),
				},
				...(bucket.provider === "googleDrive"
					? { MpuObjectSize: totalSize }
					: {}),
			});

			const head = yield* bucket.headObject(claims.key).pipe(
				Effect.retry({
					times: 3,
					schedule: Schedule.exponential("50 millis"),
				}),
			);

			// Part sizes are client-reported, so the earlier check alone does not
			// bound the stored object.
			if ((head.ContentLength ?? 0) > MAX_MEDIA_OBJECT_BYTES) {
				yield* bucket
					.deleteObject(claims.key)
					.pipe(Effect.catchAll(Effect.logError));
				c.status(413);
				return c.json({ error: "Recording is too large" });
			}

			const size = head.ContentLength ?? totalSize;
			const withinBudget = yield* Effect.tryPromise(() =>
				reserveCommentMediaBytes({
					videoId: claims.videoId,
					userId: claims.userId,
					bytes: size,
					objectKey: claims.key,
				}),
			);
			if (!withinBudget) {
				yield* bucket
					.deleteObject(claims.key)
					.pipe(Effect.catchAll(Effect.logError));
				c.status(413);
				return c.json({ error: "Recording is too large" });
			}

			// No videos-row update, no transcription queue, no videoUploads delete:
			// comment media is a leaf object, not a Cap video.
			return c.json({
				success: true,
				processingStarted: true,
				key: claims.key,
				size,
				contentType: head.ContentType ?? claims.contentType,
			});
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchAll(() =>
				Effect.succeed<Response>(
					c.json({ error: "Error completing comment media upload" }, 500),
				),
			),
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
	},
);

app.post(
	"/abort",
	zValidator(
		"json",
		z.object({
			uploadToken: z.string(),
			uploadId: z.string(),
			videoId: z.string().optional(),
			subpath: z.string().optional(),
		}),
	),
	async (c) => {
		const { uploadToken, uploadId } = c.req.valid("json");
		const user = c.get("user");
		const claims = verifiedClaims(c, uploadToken);
		if (!claims) return c.json({ error: "Invalid upload token" }, 403);

		return Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const maybeVideo = yield* repo.getById(
				Video.VideoId.make(claims.videoId),
			);
			if (Option.isNone(maybeVideo)) return yield* new Video.NotFoundError();
			const [bucket] = yield* Storage.getAccessForVideo(maybeVideo.value[0]);

			yield* bucket.multipart.abort(claims.key, uploadId);
			return c.json({ success: true });
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchAll(() =>
				Effect.succeed<Response>(
					c.json({ error: "Error aborting comment media upload" }, 500),
				),
			),
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
	},
);
