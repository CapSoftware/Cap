import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { type DatabaseError, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Schema } from "effect/Schema";
import { Database } from "../Database.ts";
import {
	createVideoWithShareableLinkQuota,
	isShareableLinkUsageLimitError,
} from "../ShareableLinkUsage.ts";

export type CreateVideoInput = Omit<
	Schema.Type<typeof Video.Video>,
	"id" | "createdAt" | "updatedAt"
> & { password?: string; importSource?: Video.ImportSource };

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
									metadata: v.metadata as Record<string, unknown> | null,
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
						db.delete(Db.importedVideos).where(Dz.eq(Db.importedVideos.id, id)),
						db.delete(Db.videos).where(Dz.eq(Db.videos.id, id)),
						db
							.delete(Db.videoUploads)
							.where(Dz.eq(Db.videoUploads.videoId, id)),
					]);
				});
			});

		const create = (data: CreateVideoInput) =>
			Effect.gen(function* () {
				const id = Video.VideoId.make(nanoId());

				yield* db
					.use((db) =>
						createVideoWithShareableLinkQuota({
							client: db,
							ownerId: data.ownerId,
							durationSeconds: Option.getOrNull(data.duration ?? Option.none()),
							create: async (db) => {
								await db.insert(Db.videos).values([
									{
										...data,
										id,
										orgId: data.orgId,
										bucket: Option.getOrNull(data.bucketId ?? Option.none()),
										storageIntegrationId: Option.getOrNull(
											data.storageIntegrationId ?? Option.none(),
										),
										metadata: Option.getOrNull(data.metadata ?? Option.none()),
										transcriptionStatus: Option.getOrNull(
											data.transcriptionStatus ?? Option.none(),
										),
										folderId: Option.getOrNull(data.folderId ?? Option.none()),
										width: Option.getOrNull(data.width ?? Option.none()),
										height: Option.getOrNull(data.height ?? Option.none()),
										duration: Option.getOrNull(data.duration ?? Option.none()),
									},
								]);

								if (data.importSource)
									await db.insert(Db.importedVideos).values([
										{
											id,
											orgId: data.orgId,
											source: data.importSource.source,
											sourceId: data.importSource.id,
										},
									]);
							},
						}),
					)
					.pipe(
						Effect.mapError(
							(error): DatabaseError | Video.ShareableLinkUsageLimitError => {
								if (isShareableLinkUsageLimitError(error.cause))
									return error.cause;
								return error;
							},
						),
					);

				return id;
			});

		return { getById, delete: delete_, create };
	}),
	dependencies: [Database.Default],
}) {}
