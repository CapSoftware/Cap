import * as Db from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { CurrentUser, Folder, Policy, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Array, Context, Effect, Option, pipe } from "effect";
import type { Schema } from "effect/Schema";

import { Database } from "../Database.ts";
import { S3Buckets } from "../S3Buckets/index.ts";
import { VideosPolicy } from "./VideosPolicy.ts";
import { VideosRepo } from "./VideosRepo.ts";
import type { CreateVideoInput as RepoCreateVideoInput } from "./VideosRepo.ts";

type UploadProgressUpdateInput = Schema.Type<
	typeof Video.UploadProgressUpdateInput
>;
type InstantRecordingCreateInput = Schema.Type<
	typeof Video.InstantRecordingCreateInput
>;

export class Videos extends Effect.Service<Videos>()("Videos", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const repo = yield* VideosRepo;
		const policy = yield* VideosPolicy;
		const s3Buckets = yield* S3Buckets;

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
				const maybeVideo = yield* repo.getById(videoId);
				if (Option.isNone(maybeVideo))
					return yield* Effect.fail(new Video.NotFoundError());
				const [video] = maybeVideo.value;

				const [bucket] = yield* s3Buckets.getBucketAccess(video.bucketId);

				yield* repo
					.delete(video.id)
					.pipe(Policy.withPolicy(policy.isOwner(video.id)));

				yield* Effect.log(`Deleted video ${video.id}`);

				const prefix = `${video.ownerId}/${video.id}/`;

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
				const maybeVideo = yield* repo
					.getById(videoId)
					.pipe(Policy.withPolicy(policy.isOwner(videoId)));
				if (Option.isNone(maybeVideo))
					return yield* Effect.fail(new Video.NotFoundError());
				const [video] = maybeVideo.value;

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

				if (result == null) return Option.none();
				return Option.some(new Video.UploadProgress(result));
			}),

			updateUploadProgress: Effect.fn("Videos.updateUploadProgress")(function* (
				input: UploadProgressUpdateInput,
			) {
				const uploaded = Math.min(input.uploaded, input.total);
				const total = input.total;
				const updatedAt = input.updatedAt;
				const videoId = input.videoId;

				const [record] = yield* db
					.use((db) =>
					db
						.select({
							video: Db.videos,
							upload: Db.videoUploads,
						})
						.from(Db.videos)
						.leftJoin(
							Db.videoUploads,
							Dz.eq(Db.videos.id, Db.videoUploads.videoId),
						)
						.where(
								Dz.eq(Db.videos.id, videoId),
						),
					)
					.pipe(Policy.withPolicy(policy.isOwner(videoId)));

				if (!record) return yield* Effect.fail(new Video.NotFoundError());

				yield* db.use((db) =>
					db.transaction(async (tx) => {
						if (record.upload) {
							if (uploaded === total && record.upload.mode === "singlepart") {
								await tx
									.delete(Db.videoUploads)
									.where(Dz.eq(Db.videoUploads.videoId, videoId));
								return;
							}

							await tx
								.update(Db.videoUploads)
								.set({
									uploaded,
									total,
									updatedAt,
								})
								.where(
									Dz.and(
										Dz.eq(Db.videoUploads.videoId, videoId),
										Dz.lte(Db.videoUploads.updatedAt, updatedAt),
									),
								);
							return;
						}

						await tx.insert(Db.videoUploads).values({
							videoId,
							uploaded,
							total,
							updatedAt,
						});
					}),
				);

				return true as const;
			}),

			createInstantRecording: Effect.fn("Videos.createInstantRecording")(
				function* (input: InstantRecordingCreateInput) {
				const user = yield* CurrentUser;

					if (user.activeOrganizationId !== input.orgId)
						return yield* Effect.fail(new Policy.PolicyDeniedError());

					const [customBucket] = yield* db.use((db) =>
						db
							.select()
							.from(Db.s3Buckets)
							.where(Dz.eq(Db.s3Buckets.ownerId, user.id)),
					);

					const bucketId = Option.fromNullable(customBucket?.id);
					const folderId = input.folderId ?? Option.none<Folder.FolderId>();
					const width = Option.fromNullable(input.width);
					const height = Option.fromNullable(input.height);
					const duration = Option.fromNullable(input.durationSeconds);

					const now = new Date();
					const formattedDate = `${now.getDate()} ${now.toLocaleString("default", {
						month: "long",
					})} ${now.getFullYear()}`;

				const createData = {
					ownerId: user.id,
					orgId: input.orgId,
					name: `Cap Recording - ${formattedDate}`,
					public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
					source: { type: "desktopMP4" as const },
					bucketId,
					folderId,
					width,
					height,
					duration,
					metadata: Option.none(),
					transcriptionStatus: Option.none(),
				} as unknown as RepoCreateVideoInput;
				const videoId = yield* repo.create(createData);

					if (input.supportsUploadProgress ?? true)
						yield* db.use((db) =>
							db.insert(Db.videoUploads).values({
								videoId,
								mode: "singlepart",
							}),
						);

					const fileKey = `${user.id}/${videoId}/result.mp4`;
					const [bucket] = yield* s3Buckets.getBucketAccess(bucketId);
					const presignedPostData = yield* bucket.getPresignedPostUrl(
						fileKey,
						{
							Fields: {
								"Content-Type": "video/mp4",
								"x-amz-meta-userid": user.id,
								"x-amz-meta-duration": input.durationSeconds
									? input.durationSeconds.toString()
									: "",
								"x-amz-meta-resolution": input.resolution ?? "",
								"x-amz-meta-videocodec": input.videoCodec ?? "",
								"x-amz-meta-audiocodec": input.audioCodec ?? "",
							},
							Expires: 1800,
						},
					);

					const shareUrl = `${serverEnv().WEB_URL}/s/${videoId}`;

					if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
						yield* Effect.tryPromise(() =>
							dub()
								.links.create({
									url: shareUrl,
									domain: "cap.link",
									key: videoId,
								}),
						).pipe(
							Effect.catchAll((error) =>
								Effect.logWarning(
									`Dub link create failed: ${String(error)}`,
								),
							),
						);

					return {
						id: videoId,
						shareUrl,
						upload: {
							url: presignedPostData.url,
							fields: presignedPostData.fields,
						},
					};
				},
			),

			create: Effect.fn("Videos.create")(repo.create),

			getDownloadInfo: Effect.fn("Videos.getDownloadInfo")(function* (
				videoId: Video.VideoId,
			) {
				const maybeVideo = yield* repo
					.getById(videoId)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));
				if (Option.isNone(maybeVideo))
					return yield* Effect.fail(new Video.NotFoundError());
				const [video] = maybeVideo.value;

				const [bucket] = yield* s3Buckets.getBucketAccess(video.bucketId);

				const src = Video.Video.getSource(video);
				if (!src) return Option.none();
				if (!(src instanceof Video.Mp4Source)) return Option.none();

				const downloadUrl = yield* bucket.getSignedObjectUrl(src.getFileKey());
				return Option.some({ fileName: `${video.name}.mp4`, downloadUrl });
			}),

			getThumbnailURL: Effect.fn("Videos.getThumbnailURL")(function* (
				videoId: Video.VideoId,
			) {
				const maybeVideo = yield* repo
					.getById(videoId)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));
				if (Option.isNone(maybeVideo)) return Option.none();
				const [video] = maybeVideo.value;

				const [bucket] = yield* s3Buckets.getBucketAccess(video.bucketId);
				const listResponse = yield* bucket.listObjects({
					prefix: `${video.ownerId}/${video.id}/`,
				});
				const contents = listResponse.Contents || [];
				const thumbnailKey = contents.find((item) =>
					item.Key?.endsWith("screen-capture.jpg"),
				)?.Key;
				if (!thumbnailKey) return Option.none();
				const url = yield* bucket.getSignedObjectUrl(thumbnailKey);
				return Option.some(url);
			}),

			getAnalytics: Effect.fn("Videos.getAnalytics")(function* (
				videoId: Video.VideoId,
			) {
				const maybeVideo = yield* repo
					.getById(videoId)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));
				if (Option.isNone(maybeVideo))
					return yield* Effect.fail(new Video.NotFoundError());
				const [video] = maybeVideo.value;

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
		};
	}),
	dependencies: [
		VideosPolicy.Default,
		VideosRepo.Default,
		Database.Default,
		S3Buckets.Default,
	],
}) {}
