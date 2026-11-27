import * as Db from "@cap/database/schema";
import {
	Database,
	makeCurrentUserLayer,
	provideOptionalAuth,
	S3Buckets,
	Storage,
	Videos,
	VideosPolicy,
} from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import { runPromise } from "@/lib/server";
import { zValidator } from "@/utils/zod-validator";

const runPromiseAnyEnv = runPromise as <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Promise<A>;

const MAX_UPLOAD_PAGES = 10;
const RECORDER_KEYS = [
	"raw-upload.mp4",
	"raw-upload.webm",
	"camera-upload.mp4",
	"camera-upload.webm",
	"mic-upload.webm",
	"mic-upload.mp4",
	"system-audio-upload.webm",
	"system-audio-upload.mp4",
	"result.mp4",
];

// A take left mid-recording can't be finished from another page load: its
// recording lives on only in the browser's local backup, which the recorder
// offers as a download. The cap would otherwise sit as a dead upload, so it is
// removed along with any upload still open, unless a track already finished.
export const app = new Hono()
	.use(withAuth)
	.post(
		"/",
		zValidator("json", z.object({ videoId: z.string().min(1).max(64) })),
		(c) => {
			const user = c.get("user");
			const videoId = Video.VideoId.make(c.req.valid("json").videoId);

			return Effect.gen(function* () {
				const policy = yield* VideosPolicy;
				const db = yield* Database;
				const videos = yield* Videos;

				const maybeVideo = yield* policy
					.getOwnedById(videoId)
					.pipe(
						Effect.catchTag("PolicyDenied", () =>
							Effect.succeed(Option.none()),
						),
					);
				if (Option.isNone(maybeVideo)) {
					return c.json({ status: "not-found" as const }, 404);
				}
				const [video] = maybeVideo.value;
				if (video.source.type !== "webMP4") {
					return c.json({ status: "kept" as const });
				}

				const [upload] = yield* db.use((db) =>
					db
						.select({ phase: Db.videoUploads.phase })
						.from(Db.videoUploads)
						.where(eq(Db.videoUploads.videoId, videoId)),
				);
				if (upload?.phase !== "uploading") {
					return c.json({ status: "kept" as const });
				}

				const [bucket] = yield* Storage.getAccessForVideo(video, {
					resolvePublishedOutput: false,
				});
				const prefix = `${video.ownerId}/${video.id}/`;
				const stored = yield* bucket.listObjects({ prefix, maxKeys: 1 });
				if (stored.Contents?.length) {
					return c.json({ status: "kept" as const });
				}

				if (bucket.provider === "s3") {
					const [s3] = yield* S3Buckets.getBucketAccess(video.bucketId);
					const listOpen = (listPrefix: string) =>
						Effect.gen(function* () {
							const found: { key: string; uploadId: string }[] = [];
							let keyMarker: string | undefined;
							let uploadIdMarker: string | undefined;
							for (let page = 0; page < MAX_UPLOAD_PAGES; page++) {
								const listed = yield* s3.multipart.listUploads({
									prefix: listPrefix,
									keyMarker,
									uploadIdMarker,
								});
								for (const open of listed.Uploads ?? []) {
									if (open.Key?.startsWith(prefix) && open.UploadId)
										found.push({ key: open.Key, uploadId: open.UploadId });
								}
								if (!listed.IsTruncated || !listed.NextKeyMarker) break;
								keyMarker = listed.NextKeyMarker;
								uploadIdMarker = listed.NextUploadIdMarker;
							}
							return found;
						});
					// MinIO lists multipart uploads only for an exact object key, not
					// a folder prefix, so each recorder key is listed as well.
					const listings = yield* Effect.forEach(
						[prefix, ...RECORDER_KEYS.map((key) => `${prefix}${key}`)],
						listOpen,
						{ concurrency: 4 },
					);
					const open = new Map(
						listings.flat().map((upload) => [upload.uploadId, upload]),
					);
					yield* Effect.forEach(
						[...open.values()],
						({ key, uploadId }) =>
							s3.multipart
								.abort(key, uploadId)
								.pipe(
									Effect.catchAll((error) =>
										Effect.logWarning(
											"Could not abort abandoned upload",
											error,
										),
									),
								),
						{ concurrency: 4 },
					);
				}

				yield* videos.delete(videoId);
				return c.json({ status: "deleted" as const });
			}).pipe(
				Effect.catchAll((error) => {
					console.error("Failed to abandon recording", error);
					return Effect.succeed(c.json({ status: "error" as const }, 500));
				}),
				Effect.provide(makeCurrentUserLayer(user)),
				provideOptionalAuth,
				runPromiseAnyEnv,
			);
		},
	);
