import * as Db from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { CurrentUser, type Folder, Policy, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Array, Effect, Exit, Option } from "effect";
import type { Schema } from "effect/Schema";

import { Database } from "../Database.ts";
import { S3Buckets } from "../S3Buckets/index.ts";
import { Tinybird } from "../Tinybird/index.ts";
import { VideosPolicy } from "./VideosPolicy.ts";
import type { CreateVideoInput as RepoCreateVideoInput } from "./VideosRepo.ts";
import { VideosRepo } from "./VideosRepo.ts";

const DEFAULT_ANALYTICS_RANGE_DAYS = 90;
const escapeSqlLiteral = (value: string) => value.replace(/'/g, "''");
const formatDate = (date: Date) => date.toISOString().slice(0, 10);
const formatDateTime = (date: Date) =>
	date.toISOString().slice(0, 19).replace("T", " ");
const buildPathname = (videoId: Video.VideoId) => `/s/${videoId}`;

type UploadProgressUpdateInput = Schema.Type<
	typeof Video.UploadProgressUpdateInput
>;
type InstantRecordingCreateInput = Schema.Type<
	typeof Video.InstantRecordingCreateInput
>;
type StudioRecordingCreateInput = Schema.Type<
	typeof Video.StudioRecordingCreateInput
>;
type OptionValue<T> = T extends Option.Option<infer Value> ? Value : never;
type RepoMetadataValue = OptionValue<RepoCreateVideoInput["metadata"]>;
type RepoTranscriptionStatusValue = OptionValue<
	RepoCreateVideoInput["transcriptionStatus"]
>;

export class Videos extends Effect.Service<Videos>()("Videos", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const repo = yield* VideosRepo;
		const policy = yield* VideosPolicy;
		const s3Buckets = yield* S3Buckets;
		const tinybird = yield* Tinybird;

		const getByIdForViewing = (id: Video.VideoId) =>
			repo
				.getById(id)
				.pipe(
					Policy.withPublicPolicy(policy.canView(id)),
					Effect.withSpan("Videos.getById"),
				);

		const getAnalyticsBulkInternal = Effect.fn("Videos.getAnalyticsBulk")(
			function* (videoIds: ReadonlyArray<Video.VideoId>) {
				if (videoIds.length === 0)
					return [] as Array<Exit.Exit<{ count: number }, unknown>>;

				const now = new Date();
				const from = new Date(
					now.getTime() - DEFAULT_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000,
				);

				const videoExits = yield* Effect.forEach(
					videoIds,
					(videoId) =>
						getByIdForViewing(videoId).pipe(
							Effect.map((video) => video),
							Effect.exit,
						),
					{ concurrency: 10 },
				);

				const successfulVideos: Array<{
					index: number;
					videoId: Video.VideoId;
					video: Video.Video;
				}> = [];

				for (let index = 0; index < videoExits.length; index++) {
					const exit = videoExits[index];
					if (!exit) continue;
					if (Exit.isSuccess(exit)) {
						const maybeVideo = exit.value;
						if (Option.isSome(maybeVideo)) {
							const [video] = maybeVideo.value;
							successfulVideos.push({
								index,
								videoId: videoIds[index] ?? "",
								video,
							});
						}
					}
				}

				const countsByPathname = new Map<string, number>();

				const videosByOrg = new Map<
					string,
					Array<{ videoId: Video.VideoId; pathname: string }>
				>();
				for (const { video } of successfulVideos) {
					const key = video.orgId ?? "";
					if (!videosByOrg.has(key)) {
						videosByOrg.set(key, []);
					}
					const entries = videosByOrg.get(key);
					if (entries) {
						entries.push({
							videoId: video.id,
							pathname: buildPathname(video.id),
						});
					}
				}

				const runTinybirdQuery = <
					Row extends { pathname?: string | null; views?: number },
				>(
					sql: string,
				) =>
					tinybird.querySql<Row>(sql).pipe(
						Effect.catchAll((error) => {
							console.error("tinybird analytics query failed", {
								sql,
								error,
							});
							return Effect.succeed<{ data: Row[] }>({ data: [] });
						}),
						Effect.map((response) => response.data ?? []),
					);

				for (const [orgKey, entries] of videosByOrg) {
					const pathnames = entries.map((entry) => entry.pathname);
					if (pathnames.length === 0) continue;

					const escapedPathnames = pathnames
						.map((pathname) => `'${escapeSqlLiteral(pathname)}'`)
						.join(", ");
					const tenantCondition =
						orgKey.length > 0
							? `tenant_id = '${escapeSqlLiteral(orgKey)}' AND `
							: "";

					const aggregateSql = `
						SELECT pathname, coalesce(uniqMerge(visits), 0) AS views
						FROM analytics_pages_mv
						WHERE ${tenantCondition}pathname IN (${escapedPathnames})
							AND date BETWEEN toDate('${formatDate(from)}') AND toDate('${formatDate(now)}')
						GROUP BY pathname
					`;

					const rawSql = `
						SELECT coalesce(pathname, '') AS pathname, coalesce(uniq(session_id), 0) AS views
						FROM analytics_events
						WHERE ${tenantCondition}pathname IN (${escapedPathnames})
							AND action = 'page_hit'
							AND timestamp BETWEEN toDateTime('${formatDateTime(from)}') AND toDateTime('${formatDateTime(now)}')
						GROUP BY pathname
					`;

					const aggregateRows = yield* runTinybirdQuery(aggregateSql);
					const rows =
						aggregateRows.length > 0
							? aggregateRows
							: yield* runTinybirdQuery(rawSql);

					for (const row of rows) {
						const pathname = row.pathname ?? "";
						const value = Number(row.views ?? 0);
						if (!pathname) continue;
						countsByPathname.set(pathname, Number.isFinite(value) ? value : 0);
					}
				}

				for (const { videoId } of successfulVideos) {
					const pathname = buildPathname(videoId);
					if (!countsByPathname.has(pathname)) {
						countsByPathname.set(pathname, 0);
					}
				}

				return videoExits.map((exit, index) =>
					Exit.map(exit, () => ({
						count:
							countsByPathname.get(buildPathname(videoIds[index] ?? "")) ?? 0,
					})),
				);
			},
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
								phase: Db.videoUploads.phase,
								processingProgress: Db.videoUploads.processingProgress,
								processingMessage: Db.videoUploads.processingMessage,
								processingError: Db.videoUploads.processingError,
							})
							.from(Db.videoUploads)
							.where(Dz.eq(Db.videoUploads.videoId, videoId)),
					)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));

				if (result == null) return Option.none();
				return Option.some(
					new Video.UploadProgress({
						uploaded: result.uploaded,
						total: result.total,
						startedAt: result.startedAt,
						updatedAt: result.updatedAt,
						phase: result.phase,
						processingProgress: result.processingProgress,
						processingMessage: Option.fromNullable(result.processingMessage),
						processingError: Option.fromNullable(result.processingError),
					}),
				);
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
							.where(Dz.eq(Db.videos.id, videoId)),
					)
					.pipe(Policy.withPolicy(policy.isOwner(videoId)));

				if (!record) return yield* Effect.fail(new Video.NotFoundError());

				yield* db.use((db) =>
					db.transaction(async (tx) => {
						if (record.upload) {
							if (uploaded === total && record.upload.mode !== "multipart") {
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

					const bucketId: RepoCreateVideoInput["bucketId"] =
						Option.fromNullable(customBucket?.id);
					const folderId: RepoCreateVideoInput["folderId"] =
						input.folderId ?? Option.none<Folder.FolderId>();
					const width: RepoCreateVideoInput["width"] = Option.fromNullable(
						input.width,
					);
					const height: RepoCreateVideoInput["height"] = Option.fromNullable(
						input.height,
					);
					const duration: RepoCreateVideoInput["duration"] =
						Option.fromNullable(input.durationSeconds);

					const now = new Date();
					const formattedDate = `${now.getDate()} ${now.toLocaleString(
						"default",
						{
							month: "long",
						},
					)} ${now.getFullYear()}`;

					const createData: RepoCreateVideoInput = {
						ownerId: user.id,
						orgId: input.orgId,
						name: `Cap Recording - ${formattedDate}`,
						public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
						source: { type: "webMP4" },
						bucketId,
						folderId,
						width,
						height,
						duration,
						metadata: Option.none<RepoMetadataValue>(),
						transcriptionStatus: Option.none<RepoTranscriptionStatusValue>(),
					};
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
					const presignedPostData = yield* bucket.getPresignedPostUrl(fileKey, {
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
					});

					const shareUrl = `${serverEnv().WEB_URL}/s/${videoId}`;

					if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
						yield* Effect.tryPromise(() =>
							dub().links.create({
								url: shareUrl,
								domain: "cap.link",
								key: videoId,
							}),
						).pipe(
							Effect.catchAll((error) =>
								Effect.logWarning(`Dub link create failed: ${String(error)}`),
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

			createStudioRecording: Effect.fn("Videos.createStudioRecording")(
				function* (input: StudioRecordingCreateInput) {
					const user = yield* CurrentUser;

					if (user.activeOrganizationId !== input.orgId)
						return yield* Effect.fail(new Policy.PolicyDeniedError());

					const [customBucket] = yield* db.use((db) =>
						db
							.select()
							.from(Db.s3Buckets)
							.where(Dz.eq(Db.s3Buckets.ownerId, user.id)),
					);

					const bucketId: RepoCreateVideoInput["bucketId"] =
						Option.fromNullable(customBucket?.id);
					const folderId: RepoCreateVideoInput["folderId"] =
						input.folderId ?? Option.none<Folder.FolderId>();
					const width: RepoCreateVideoInput["width"] = Option.fromNullable(
						input.width,
					);
					const height: RepoCreateVideoInput["height"] = Option.fromNullable(
						input.height,
					);
					const duration: RepoCreateVideoInput["duration"] =
						Option.fromNullable(input.durationSeconds);

					const now = new Date();
					const formattedDate = `${now.getDate()} ${now.toLocaleString(
						"default",
						{
							month: "long",
						},
					)} ${now.getFullYear()}`;

					const createData: RepoCreateVideoInput = {
						ownerId: user.id,
						orgId: input.orgId,
						name: `Cap Recording - ${formattedDate}`,
						public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
						source: { type: "webStudio" },
						bucketId,
						folderId,
						width,
						height,
						duration,
						metadata: Option.none<RepoMetadataValue>(),
						transcriptionStatus: Option.none<RepoTranscriptionStatusValue>(),
					};
					const videoId = yield* repo.create(createData);

					if (input.supportsUploadProgress ?? true)
						yield* db.use((db) =>
							db.insert(Db.videoUploads).values({
								videoId,
								mode: "singlepart",
							}),
						);

					const displayKey = `${user.id}/${videoId}/display.mp4`;
					const cameraKey = `${user.id}/${videoId}/camera.mp4`;
					const [bucket] = yield* s3Buckets.getBucketAccess(bucketId);

					const presignFields = {
						"Content-Type": "video/mp4",
						"x-amz-meta-userid": user.id,
						"x-amz-meta-duration": input.durationSeconds
							? input.durationSeconds.toString()
							: "",
						"x-amz-meta-resolution": input.resolution ?? "",
						"x-amz-meta-videocodec": input.videoCodec ?? "",
						"x-amz-meta-audiocodec": input.audioCodec ?? "",
					};

					const [displayPresigned, cameraPresigned] = yield* Effect.all([
						bucket.getPresignedPostUrl(displayKey, {
							Fields: presignFields,
							Expires: 1800,
						}),
						bucket.getPresignedPostUrl(cameraKey, {
							Fields: {
								"Content-Type": "video/mp4",
								"x-amz-meta-userid": user.id,
							},
							Expires: 1800,
						}),
					]);

					const shareUrl = `${serverEnv().WEB_URL}/s/${videoId}`;

					if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
						yield* Effect.tryPromise(() =>
							dub().links.create({
								url: shareUrl,
								domain: "cap.link",
								key: videoId,
							}),
						).pipe(
							Effect.catchAll((error) =>
								Effect.logWarning(`Dub link create failed: ${String(error)}`),
							),
						);

					return {
						id: videoId,
						shareUrl,
						displayUpload: {
							url: displayPresigned.url,
							fields: displayPresigned.fields,
						},
						cameraUpload: {
							url: cameraPresigned.url,
							fields: cameraPresigned.fields,
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

			getHoverPreviewURL: Effect.fn("Videos.getHoverPreviewURL")(function* (
				videoId: Video.VideoId,
			) {
				const maybeVideo = yield* repo
					.getById(videoId)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));
				if (Option.isNone(maybeVideo)) return Option.none();
				const [video] = maybeVideo.value;

				const [bucket] = yield* s3Buckets.getBucketAccess(video.bucketId);
				const previewKey = `${video.ownerId}/${video.id}/preview/hover.mp4`;

				const exists = yield* bucket.headObject(previewKey).pipe(
					Effect.as(true),
					Effect.catchTag("S3Error", (error) => {
						const statusCode = (error.cause as any)?.$metadata?.httpStatusCode;
						const name = (error.cause as any)?.name;
						if (statusCode === 404) return Effect.succeed(false);
						if (name === "NotFound" || name === "NoSuchKey")
							return Effect.succeed(false);
						return Effect.fail(error);
					}),
				);
				if (!exists) return Option.none();

				const url = yield* bucket.getSignedObjectUrl(previewKey);
				return Option.some(url);
			}),

			getAnalytics: Effect.fn("Videos.getAnalytics")(function* (
				videoId: Video.VideoId,
			) {
				const [result] = yield* getAnalyticsBulkInternal([videoId]);
				if (!result) return { count: 0 };
				return yield* Exit.matchEffect(result, {
					onSuccess: (value) => Effect.succeed(value),
					onFailure: (error) => Effect.fail(error),
				});
			}),
			getAnalyticsBulk: getAnalyticsBulkInternal,
		};
	}),
	dependencies: [
		VideosPolicy.Default,
		VideosRepo.Default,
		Database.Default,
		S3Buckets.Default,
		Tinybird.Default,
	],
}) {}
