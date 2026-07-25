import * as Db from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { CurrentUser, type Folder, Policy, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Array as EffectArray, Exit, Option } from "effect";
import type { Schema } from "effect/Schema";

import { Database } from "../Database.ts";
import { Storage as StorageService } from "../Storage/index.ts";
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
const SCREENSHOT_OBJECT_KEY_SUFFIXES = [
	"screenshot/screen-capture.png",
	"screenshot/screen-capture.jpg",
	"screenshot/screen-capture.jpeg",
	"screen-capture.jpg",
	"screen-capture.jpeg",
];
type ScreenshotObject = {
	Key?: string | null;
	LastModified?: Date | string | number | null;
};
type ScreenshotCandidate = {
	key: string;
	suffixIndex: number;
	lastModified: number | null;
};
const getScreenshotObjectTime = (value: ScreenshotObject["LastModified"]) => {
	if (value == null) return null;
	const time =
		value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(time) ? time : null;
};
export const findScreenshotObjectKey = (
	contents: ReadonlyArray<ScreenshotObject>,
) => {
	const candidates = contents
		.map((item): ScreenshotCandidate | null => {
			const key = item.Key;
			if (!key) return null;
			const suffixIndex = SCREENSHOT_OBJECT_KEY_SUFFIXES.findIndex((suffix) =>
				key.endsWith(suffix),
			);
			if (suffixIndex < 0) return null;
			return {
				key,
				suffixIndex,
				lastModified: getScreenshotObjectTime(item.LastModified),
			};
		})
		.filter((item): item is ScreenshotCandidate => item !== null)
		.sort((a, b) => {
			if (a.lastModified !== null || b.lastModified !== null) {
				const timeDiff =
					(b.lastModified ?? Number.NEGATIVE_INFINITY) -
					(a.lastModified ?? Number.NEGATIVE_INFINITY);
				if (timeDiff !== 0) return timeDiff;
			}
			return a.suffixIndex - b.suffixIndex;
		});

	return candidates[0]?.key ?? null;
};
const getFileExtensionFromKey = (fileKey: string) => {
	const fileName = fileKey.split("/").at(-1) ?? "";
	const extension = fileName.split(".").at(-1)?.toLowerCase();

	if (!extension || extension === fileName.toLowerCase()) {
		return null;
	}

	return extension;
};

type UploadProgressUpdateInput = Schema.Type<
	typeof Video.UploadProgressUpdateInput
>;
type InstantRecordingCreateInput = Schema.Type<
	typeof Video.InstantRecordingCreateInput
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
		const storage = yield* StorageService;
		const tinybird = yield* Tinybird;

		const getByIdForViewing = (id: Video.VideoId) =>
			repo
				.getById(id)
				.pipe(
					Policy.withPublicPolicy(policy.canView(id)),
					Effect.withSpan("Videos.getById"),
				);

		const getAnalyticsCounts = Effect.fn("Videos.getAnalyticsCounts")(
			function* (
				analyticsVideos: ReadonlyArray<{
					id: Video.VideoId;
					orgId: string;
				}>,
			) {
				const now = new Date();
				const from = new Date(
					now.getTime() - DEFAULT_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000,
				);
				const countsByPathname = new Map<string, number>();

				const videosByOrg = new Map<
					string,
					Array<{ videoId: Video.VideoId; pathname: string }>
				>();
				for (const video of analyticsVideos) {
					const key = video.orgId;
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

				for (const video of analyticsVideos) {
					const pathname = buildPathname(video.id);
					if (!countsByPathname.has(pathname)) {
						countsByPathname.set(pathname, 0);
					}
				}

				return countsByPathname;
			},
		);

		const getAnalyticsBulkInternal = Effect.fn("Videos.getAnalyticsBulk")(
			function* (videoIds: ReadonlyArray<Video.VideoId>) {
				if (videoIds.length === 0)
					return [] as Array<Exit.Exit<{ count: number }, unknown>>;

				const videoExits = yield* Effect.forEach(
					videoIds,
					(videoId) => getByIdForViewing(videoId).pipe(Effect.exit),
					{ concurrency: 10 },
				);
				const analyticsVideos = videoExits.flatMap((exit) => {
					if (!Exit.isSuccess(exit) || Option.isNone(exit.value)) return [];
					const [video] = exit.value.value;
					return [{ id: video.id, orgId: video.orgId }];
				});
				const countsByPathname = yield* getAnalyticsCounts(analyticsVideos);

				return videoExits.map((exit, index) =>
					Exit.map(exit, () => ({
						count:
							countsByPathname.get(buildPathname(videoIds[index] ?? "")) ?? 0,
					})),
				);
			},
		);

		const getAnalyticsBulkForOwner = Effect.fn(
			"Videos.getAnalyticsBulkForOwner",
		)(function* (
			videoIds: ReadonlyArray<Video.VideoId>,
			ownerId: (typeof Db.videos.$inferSelect)["ownerId"],
		) {
			if (videoIds.length === 0) return [];
			const uniqueVideoIds = Array.from(new Set(videoIds));
			const rows = yield* db.use((database) =>
				database
					.select({ id: Db.videos.id, orgId: Db.videos.orgId })
					.from(Db.videos)
					.where(
						Dz.and(
							Dz.eq(Db.videos.ownerId, ownerId),
							Dz.inArray(Db.videos.id, uniqueVideoIds),
						),
					),
			);
			const countsByPathname = yield* getAnalyticsCounts(rows);

			return videoIds.map((videoId) => ({
				count: countsByPathname.get(buildPathname(videoId)) ?? 0,
			}));
		});

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

				const [bucket] = yield* storage.getAccessForVideo(video);

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

				const [bucket] = yield* storage.getAccessForVideo(video);

				// Don't duplicate password or sharing data
				const newVideoId = yield* repo.create(video);

				const prefix = `${video.ownerId}/${video.id}/`;
				const newPrefix = `${video.ownerId}/${newVideoId}/`;

				const allObjects = yield* bucket.listObjects({ prefix });

				if (allObjects.Contents)
					yield* Effect.all(
						EffectArray.filterMap(allObjects.Contents, (obj) =>
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
								rawFileKey: Db.videoUploads.rawFileKey,
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
						hasRawFallback: result.rawFileKey != null,
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

					const writable = yield* storage.getWritableAccessForUser(
						user.id,
						input.orgId,
					);
					const bucketId: RepoCreateVideoInput["bucketId"] = writable.bucketId;
					const storageIntegrationId: RepoCreateVideoInput["storageIntegrationId"] =
						writable.storageIntegrationId;
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
						storageIntegrationId,
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
					const upload = yield* writable.access.createUploadTarget(fileKey, {
						contentType: "video/mp4",
						fields: {
							"Content-Type": "video/mp4",
							"x-amz-meta-userid": user.id,
							"x-amz-meta-duration": input.durationSeconds
								? input.durationSeconds.toString()
								: "",
							"x-amz-meta-resolution": input.resolution ?? "",
							"x-amz-meta-videocodec": input.videoCodec ?? "",
							"x-amz-meta-audiocodec": input.audioCodec ?? "",
						},
					});

					const canonicalShareUrl = `${serverEnv().WEB_URL}/s/${videoId}`;

					const verifiedCustomDomain = yield* db
						.use((db) =>
							db
								.select({
									customDomain: Db.organizations.customDomain,
									domainVerified: Db.organizations.domainVerified,
								})
								.from(Db.organizations)
								.where(Dz.eq(Db.organizations.id, input.orgId))
								.limit(1),
						)
						.pipe(
							Effect.map(([org]) =>
								org?.customDomain && org.domainVerified
									? org.customDomain.startsWith("http://") ||
										org.customDomain.startsWith("https://")
										? org.customDomain
										: `https://${org.customDomain}`
									: null,
							),
							Effect.catchAll(() => Effect.succeed(null)),
						);

					const shareUrl = verifiedCustomDomain
						? `${verifiedCustomDomain}/s/${videoId}`
						: canonicalShareUrl;

					if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
						yield* Effect.tryPromise(() =>
							dub().links.create({
								url: canonicalShareUrl,
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
						upload,
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

				const [bucket] = yield* storage.getAccessForVideo(video);
				const [videoRow] = yield* db.use((db) =>
					db
						.select({ isScreenshot: Db.videos.isScreenshot })
						.from(Db.videos)
						.where(Dz.eq(Db.videos.id, videoId)),
				);

				if (videoRow?.isScreenshot) {
					const listResponse = yield* bucket.listObjects({
						prefix: `${video.ownerId}/${video.id}/`,
					});
					const screenshotKey = findScreenshotObjectKey(
						listResponse.Contents || [],
					);
					if (!screenshotKey) return Option.none();
					const extension = getFileExtensionFromKey(screenshotKey) ?? "jpg";
					const downloadUrl = yield* bucket.getSignedObjectUrl(screenshotKey);
					return Option.some({
						fileName: `${video.name}.${extension}`,
						downloadUrl,
					});
				}

				const src = Video.Video.getSource(video);

				if (src instanceof Video.Mp4Source && video.source.type === "webMP4") {
					const mp4Head = yield* bucket
						.headObject(src.getFileKey())
						.pipe(Effect.option);

					if (
						Option.isSome(mp4Head) &&
						(mp4Head.value.ContentLength ?? 0) > 0
					) {
						const downloadUrl = yield* bucket.getSignedObjectUrl(
							src.getFileKey(),
						);

						return Option.some({
							fileName: `${video.name}.mp4`,
							downloadUrl,
						});
					}

					const [upload] = yield* db.use((db) =>
						db
							.select({ rawFileKey: Db.videoUploads.rawFileKey })
							.from(Db.videoUploads)
							.where(Dz.eq(Db.videoUploads.videoId, video.id)),
					);

					if (upload?.rawFileKey) {
						const downloadUrl = yield* bucket.getSignedObjectUrl(
							upload.rawFileKey,
						);
						const extension =
							getFileExtensionFromKey(upload.rawFileKey) ?? "mp4";

						return Option.some({
							fileName: `${video.name}.${extension}`,
							downloadUrl,
						});
					}
				}

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

				const [bucket] = yield* storage.getAccessForVideo(video);
				const listResponse = yield* bucket.listObjects({
					prefix: `${video.ownerId}/${video.id}/`,
				});
				const contents = listResponse.Contents || [];
				const thumbnailKey = findScreenshotObjectKey(contents);
				if (!thumbnailKey) return Option.none();
				const url = yield* bucket.getSignedObjectUrl(thumbnailKey);
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
			getAnalyticsBulkForOwner,
		};
	}),
	dependencies: [
		VideosPolicy.Default,
		VideosRepo.Default,
		Database.Default,
		StorageService.Default,
		Tinybird.Default,
	],
}) {}
