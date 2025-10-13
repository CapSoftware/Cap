import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import type { MySqlInsertBase } from "drizzle-orm/mysql-core";
import { Effect, Option } from "effect";
import type { Schema } from "effect/Schema";
import { Database } from "../Database.ts";

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
									createdAt: v.createdAt.toISOString(),
									updatedAt: v.updatedAt.toISOString(),
									metadata: v.metadata as any,
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

				yield* db.use((db) =>
					db.transaction(async (db) => {
						const promises: MySqlInsertBase<any, any, any>[] = [
							db.insert(Db.videos).values([
								{
									...data,
									id,
									orgId: data.orgId,
									bucket: Option.getOrNull(data.bucketId ?? Option.none()),
									metadata: Option.getOrNull(data.metadata ?? Option.none()),
									transcriptionStatus: Option.getOrNull(
										data.transcriptionStatus ?? Option.none(),
									),
									folderId: Option.getOrNull(data.folderId ?? Option.none()),
									width: Option.getOrNull(data.width ?? Option.none()),
									height: Option.getOrNull(data.height ?? Option.none()),
									duration: Option.getOrNull(data.duration ?? Option.none()),
								},
							]),
						];

						if (data.importSource)
							promises.push(
								db.insert(Db.importedVideos).values([
									{
										id,
										orgId: data.orgId,
										source: data.importSource.source,
										sourceId: data.importSource.id,
									},
								]),
							);

						await Promise.all(promises);
					}),
				);

				return id;
			});

		return { getById, delete: delete_, create };
	}),
	dependencies: [Database.Default],
}) {}
