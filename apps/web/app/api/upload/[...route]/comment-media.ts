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
import { zValidator } from "@hono/zod-validator";
import { and, eq, gt, inArray } from "drizzle-orm";
import { Effect, Option, Schedule } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import { commentMediaKeys } from "@/lib/comment-media";
import { canUseMediaComments } from "@/lib/media-comments";
import { runPromise } from "@/lib/server";
import { stringOrNumberOptional } from "@/utils/zod";

export const app = new Hono().use(withAuth);

const runPromiseAnyEnv = runPromise as <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Promise<A>;

// Stateless storage-growth bounds. Uploads land in the video owner's
// (possibly BYO) bucket, so an unbounded viewer must not be able to fill it
// unattended: per-commenter comment-rate, per-video object count, and a
// per-object multipart ceiling (single PUTs are capped at 5GB by S3 itself).
const MAX_MEDIA_COMMENTS_PER_HOUR = 30;
const MAX_MEDIA_OBJECTS_PER_VIDEO = 400;
const MAX_MEDIA_OBJECT_BYTES = 20 * 1024 * 1024 * 1024;

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
		}),
	),
	async (c) => {
		const {
			videoId: videoIdRaw,
			kind,
			mode,
			withThumbnail,
		} = c.req.valid("json");
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

			const [bucket] = yield* Storage.getAccessForVideo(video);

			// The comment-row throttle above only counts finished comments; an
			// initiate-and-PUT loop that never creates rows would bypass it. The
			// object count under the comments prefix is the ground truth for bytes
			// actually landed in the owner's (possibly BYO) bucket, so it is the
			// bound that matters.
			const existingObjects = yield* bucket.listObjects({
				prefix: `${video.ownerId}/${video.id}/comments/`,
				maxKeys: MAX_MEDIA_OBJECTS_PER_VIDEO,
			});
			if (
				(existingObjects.Contents?.length ?? 0) >= MAX_MEDIA_OBJECTS_PER_VIDEO
			) {
				c.status(429);
				return c.json({
					error: "This video has reached its media comment limit",
				});
			}

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

			// Drive rejects presigned POST, so upload targets are always PUT-style;
			// createUploadTarget returns the provider-appropriate target shape.
			const thumbnailUpload = thumbnailKey
				? yield* bucket.createUploadTarget(thumbnailKey, {
						contentType: "image/jpeg",
						method: "put",
					})
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
			if (mode === "single") {
				const upload = yield* bucket.createUploadTarget(key, {
					contentType,
					method: "put",
				});
				return c.json({ commentId, key, uploadToken, upload, thumbnailUpload });
			}

			const { UploadId } = yield* bucket.multipart.create(key, {
				ContentType: contentType,
				Metadata: { userId: user.id, source: "cap-comment-media" },
				CacheControl: "max-age=31536000",
			});
			if (!UploadId) return yield* Effect.fail(new Error("No UploadId"));

			return c.json({
				commentId,
				key,
				uploadToken,
				uploadId: UploadId,
				provider: bucket.provider,
				thumbnailUpload,
			});
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

			// No videos-row update, no transcription queue, no videoUploads delete:
			// comment media is a leaf object, not a Cap video.
			return c.json({
				success: true,
				processingStarted: true,
				key: claims.key,
				size: head.ContentLength ?? totalSize,
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
