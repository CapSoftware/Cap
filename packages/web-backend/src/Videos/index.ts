import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { CurrentUser, Policy, Video } from "@cap/web-domain";
import { FetchHttpClient, HttpBody, HttpClient } from "@effect/platform";
import * as Dz from "drizzle-orm";
import { Array, Effect, Option, pipe } from "effect";
import { Database } from "../Database.ts";
import { S3Buckets } from "../S3Buckets/index.ts";
import { VideosPolicy } from "./VideosPolicy.ts";
import { VideosRepo } from "./VideosRepo.ts";

export class Videos extends Effect.Service<Videos>()("Videos", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const repo = yield* VideosRepo;
		const policy = yield* VideosPolicy;
		const s3Buckets = yield* S3Buckets;
		const client = yield* HttpClient.HttpClient;

		const getByIdForViewing = (id: Video.VideoId) =>
			repo
				.getById(id)
				.pipe(
					Policy.withPublicPolicy(policy.canView(id)),
					Effect.withSpan("Videos.getById"),
				);

		return {
			/*
			 * Get a video by ID. Will fail if the user does not have access.
			 */
			// This is only for external use since it does an access check,
			// internal use should prefer the repo directly
			getByIdForViewing,

			/*
			 * Delete a video. Will fail if the user does not have access.
			 */
			delete: Effect.fn("Videos.delete")(function* (videoId: Video.VideoId) {
				const [video] = yield* repo
					.getById(videoId)
					.pipe(
						Effect.flatMap(Effect.catchAll(() => new Video.NotFoundError())),
					);

				const [bucket] = yield* s3Buckets.getBucketAccess(video.bucketId);

				yield* repo
					.delete(video.id)
					.pipe(Policy.withPolicy(policy.isOwner(video.id)));

				yield* Effect.log(`Deleted video ${video.id}`);

				const user = yield* CurrentUser;

				const prefix = `${user.id}/${video.id}/`;

				const listedObjects = yield* bucket.listObjects({ prefix });

				if (listedObjects.Contents) {
					yield* bucket.deleteObjects(
						listedObjects.Contents.map((content) => ({
							Key: content.Key,
						})),
					);
				}
			}),

			/*
			 * Duplicates a video, its metadata, and its media files.
			 * Comments and reactions will not be duplicated or carried over.
			 */
			duplicate: Effect.fn("Videos.duplicate")(function* (
				videoId: Video.VideoId,
			) {
				const [video] = yield* repo
					.getById(videoId)
					.pipe(
						Effect.flatMap(Effect.catchAll(() => new Video.NotFoundError())),
						Policy.withPolicy(policy.isOwner(videoId)),
					);

				const [bucket] = yield* s3Buckets.getBucketAccess(video.bucketId);

				// Don't duplicate password or sharing data
				const newVideoId = yield* repo.create(video);

				const prefix = `${video.ownerId}/${video.id}/`;
				const newPrefix = `${video.ownerId}/${newVideoId}/`;

				const allObjects = yield* bucket.listObjects({ prefix });

				if (allObjects.Contents)
					yield* Effect.all(
						Array.filterMap(allObjects.Contents, (obj) =>
							Option.map(Option.fromNullable(obj.Key), (key) => {
								const newKey = key.replace(prefix, newPrefix);
								return bucket.copyObject(
									`${bucket.bucketName}/${obj.Key}`,
									newKey,
								);
							}),
						),
						{ concurrency: 1 },
					);
			}),

			/*
			 * Gets the progress of a video upload.
			 */
			getUploadProgress: Effect.fn("Videos.getUploadProgress")(function* (
				videoId: Video.VideoId,
			) {
				const [result] = yield* db
					.use((db) =>
						db
							.select({
								uploaded: Db.videoUploads.uploaded,
								total: Db.videoUploads.total,
								startedAt: Db.videoUploads.startedAt,
								updatedAt: Db.videoUploads.updatedAt,
							})
							.from(Db.videoUploads)
							.where(Dz.eq(Db.videoUploads.videoId, videoId)),
					)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));

				return pipe(
					result,
					Option.fromNullable,
					Option.map((r) => new Video.UploadProgress(r)),
				);
			}),

			create: Effect.fn("Videos.create")(repo.create),

			getDownloadInfo: Effect.fn("Videos.getDownloadInfo")(function* (
				videoId: Video.VideoId,
			) {
				const [video] = yield* repo
					.getById(videoId)
					.pipe(
						Effect.flatMap(
							Effect.catchTag(
								"NoSuchElementException",
								() => new Video.NotFoundError(),
							),
						),
						Policy.withPublicPolicy(policy.canView(videoId)),
					);

				const [bucket] = yield* S3Buckets.getBucketAccess(video.bucketId);

				return yield* Option.fromNullable(Video.Video.getSource(video)).pipe(
					Option.filter((v) => v._tag === "Mp4Source"),
					Option.map((v) =>
						bucket.getSignedObjectUrl(v.getFileKey()).pipe(
							Effect.map((downloadUrl) => ({
								fileName: `${video.name}.mp4`,
								downloadUrl,
							})),
						),
					),
					Effect.transposeOption,
				);
			}),

			getThumbnailURL: Effect.fn("Videos.getThumbnailURL")(function* (
				videoId: Video.VideoId,
			) {
				const videoOpt = yield* repo
					.getById(videoId)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));

				return yield* videoOpt.pipe(
					Effect.transposeMapOption(
						Effect.fn(function* ([video]) {
							const [bucket] = yield* S3Buckets.getBucketAccess(video.bucketId);

							const listResponse = yield* bucket.listObjects({
								prefix: `${video.ownerId}/${video.id}/`,
							});
							const contents = listResponse.Contents || [];

							const thumbnailKey = contents.find((item) =>
								item.Key?.endsWith("screen-capture.jpg"),
							)?.Key;

							if (!thumbnailKey) return Option.none();

							return Option.some(
								yield* bucket.getSignedObjectUrl(thumbnailKey),
							);
						}),
					),
					Effect.map(Option.flatten),
				);
			}),

			getAnalytics: Effect.fn("Videos.getAnalytics")(function* (
				videoId: Video.VideoId,
			) {
				const [video] = yield* getByIdForViewing(videoId).pipe(
					Effect.flatten,
					Effect.catchTag(
						"NoSuchElementException",
						() => new Video.NotFoundError(),
					),
				);

				console.log("HERE GET");
				const token = serverEnv().TINYBIRD_TOKEN;
				const host = serverEnv().TINYBIRD_HOST;
				if (token && host) {
					const response2 = yield* client.get(
						`${host}/v0/pipes/video_views.json?token=${token}&video_id=${video.id}`,
					);
					if (response2.status !== 200) {
						// TODO
					}
					console.log("ANALYTICS", response2.status, yield* response2.text);

					// TODO: Effect schema
					const result = JSON.parse(yield* response2.text);
					return { count: result.data[0].count };
				}

				const response = yield* Effect.tryPromise(() =>
					dub().analytics.retrieve({
						domain: "cap.link",
						key: video.id,
					}),
				);
				const { clicks } = response as { clicks: unknown };

				if (typeof clicks !== "number" || clicks === null) return { count: 0 };

				return { count: clicks };
			}),

			captureAnalytics: Effect.fn("Videos.captureAnalytics")(function* (
				videoId: Video.VideoId,
			) {
				const token = serverEnv().TINYBIRD_TOKEN;
				const host = serverEnv().TINYBIRD_HOST;
				if (!token || !host) return;

				console.log("TINYBIRD EVENT"); // TODO
				const response = yield* client.post(
					`${host}/v0/events?name=analytics_views`,
					{
						body: HttpBody.unsafeJson({
							timestamp: new Date().toISOString(),
							version: "1",
							session_id: "todo", // TODO
							video_id: videoId,
							payload: JSON.stringify({
								hello: "world", // TODO
							}),
						}),
						headers: {
							Authorization: `Bearer ${token}`,
						},
					},
				);
				// const response = yield* HttpClientResponse.filterStatusOk(response);
				if (response.status !== 200) {
					// TODO
				}

				console.log(response.status, yield* response.text);
			}),
		};
	}),
	dependencies: [
		VideosPolicy.Default,
		VideosRepo.Default,
		Database.Default,
		S3Buckets.Default,
		FetchHttpClient.layer,
	],
}) {}
