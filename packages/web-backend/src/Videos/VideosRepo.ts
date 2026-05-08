import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Schema } from "effect/Schema";
import { Database } from "../Database.ts";

export type CreateVideoInput = Omit<
	Schema.Type<typeof Video.Video>,
	"id" | "createdAt" | "updatedAt" | "expiresAt"
> & {
	password?: string;
	importSource?: Video.ImportSource;
	expiresAt?: Option.Option<Date>;
};

type VideoMetadataInput = Schema.Type<typeof Video.Video>["metadata"];

export class VideosRepo extends Effect.Service<VideosRepo>()("VideosRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		/**
		 * Gets a `Video` and its accompanying password if available.
		 *
		 * The password is returned separately as the `Video` class is client-safe
		 */
		const getById = (id: Video.VideoId) =>
			Effect.gen(function* () {
				const [video] = yield* db.use((db) =>
					db.select().from(Db.videos).where(Dz.eq(Db.videos.id, id)),
				);

				return Option.fromNullable(video).pipe(
					Option.map(
						(v) =>
							[
								Video.Video.decodeSync({
									...v,
									bucketId: v.bucket,
									storageIntegrationId: v.storageIntegrationId,
									createdAt: v.createdAt.toISOString(),
									updatedAt: v.updatedAt.toISOString(),
									expiresAt: v.expiresAt?.toISOString() ?? null,
									metadata: v.metadata as VideoMetadataInput,
								}),
								Option.fromNullable(video?.password),
							] as const,
					),
				);
			});

		const delete_ = (id: Video.VideoId) =>
			db.use(async (db) => {
				await db.transaction(async (db) => {
					await Promise.all([
						db.delete(Db.comments).where(Dz.eq(Db.comments.videoId, id)),
						db.delete(Db.importedVideos).where(Dz.eq(Db.importedVideos.id, id)),
						db
							.delete(Db.notifications)
							.where(Dz.eq(Db.notifications.videoId, id)),
						db
							.delete(Db.sharedVideos)
							.where(Dz.eq(Db.sharedVideos.videoId, id)),
						db.delete(Db.spaceVideos).where(Dz.eq(Db.spaceVideos.videoId, id)),
						db
							.delete(Db.storageObjects)
							.where(Dz.eq(Db.storageObjects.videoId, id)),
						db
							.delete(Db.videoUploads)
							.where(Dz.eq(Db.videoUploads.videoId, id)),
					]);
					await db.delete(Db.videos).where(Dz.eq(Db.videos.id, id));
				});
			});

		const create = (data: CreateVideoInput) =>
			Effect.gen(function* () {
				const id = Video.VideoId.make(nanoId());

				yield* db.use((db) =>
					db.transaction(async (db) => {
						const {
							bucketId,
							duration,
							expiresAt,
							folderId,
							height,
							importSource,
							metadata,
							storageIntegrationId,
							transcriptionStatus,
							width,
							...videoData
						} = data;

						const insertVideo = db.insert(Db.videos).values([
							{
								...videoData,
								id,
								orgId: videoData.orgId,
								bucket: Option.getOrNull(bucketId ?? Option.none()),
								storageIntegrationId: Option.getOrNull(
									storageIntegrationId ?? Option.none(),
								),
								metadata: Option.getOrNull(metadata ?? Option.none()),
								transcriptionStatus: Option.getOrNull(
									transcriptionStatus ?? Option.none(),
								),
								folderId: Option.getOrNull(folderId ?? Option.none()),
								width: Option.getOrNull(width ?? Option.none()),
								height: Option.getOrNull(height ?? Option.none()),
								duration: Option.getOrNull(duration ?? Option.none()),
								expiresAt: Option.getOrNull(expiresAt ?? Option.none<Date>()),
							},
						]);

						const insertImport = importSource
							? db.insert(Db.importedVideos).values([
									{
										id,
										orgId: videoData.orgId,
										source: importSource.source,
										sourceId: importSource.id,
									},
								])
							: undefined;

						if (insertImport) await Promise.all([insertVideo, insertImport]);
						else await insertVideo;
					}),
				);

				return id;
			});

		const setExpiresAt = (id: Video.VideoId, expiresAt: Option.Option<Date>) =>
			db.use((db) =>
				db
					.update(Db.videos)
					.set({ expiresAt: Option.getOrNull(expiresAt) })
					.where(Dz.eq(Db.videos.id, id)),
			);

		const getExpiredIds = (now: Date, limit: number) =>
			db.use((db) =>
				db
					.select({ id: Db.videos.id })
					.from(Db.videos)
					.where(
						Dz.and(
							Dz.isNotNull(Db.videos.expiresAt),
							Dz.lte(Db.videos.expiresAt, now),
						),
					)
					.limit(limit),
			);

		return { getById, delete: delete_, create, setExpiresAt, getExpiredIds };
	}),
	dependencies: [Database.Default],
}) {}
