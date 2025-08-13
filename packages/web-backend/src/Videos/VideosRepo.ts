import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database } from "../Database";

export class VideosRepo extends Effect.Service<VideosRepo>()("VideosRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		return {
			/**
			 * Gets a `Video` and its accompanying password if available.
			 *
			 * The password is returned separately as the `Video` class is client-safe
			 */
			getById: (id: Video.VideoId) =>
				Effect.gen(function* () {
					const [video] = yield* db.execute((db) =>
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
				}),
			delete: (id: Video.VideoId) =>
				db.execute((db) => db.delete(Db.videos).where(Dz.eq(Db.videos.id, id))),
			create: (
				data: Pick<
					(typeof Video.Video)["Encoded"],
					| "ownerId"
					| "name"
					| "bucketId"
					| "metadata"
					| "public"
					| "transcriptionStatus"
					| "source"
					| "folderId"
				> & { password?: string },
			) => {
				const id = nanoId();

				return db.execute((db) =>
					db
						.insert(Db.videos)
						.values({
							id,
							ownerId: data.ownerId,
							name: data.name,
							bucket: data.bucketId,
							metadata: data.metadata,
							public: data.public,
							transcriptionStatus: data.transcriptionStatus,
							source: data.source,
							folderId: data.folderId,
							password: data.password,
						})
						.then(() => Video.VideoId.make(id)),
				);
			},
		};
	}),
}) {}
