import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import type { User, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Array, Effect, Option } from "effect";
import type { ProjectConfiguration } from "../types/project-config";
import { createDefaultConfig, normalizeStoredConfig } from "../utils/defaults";

export interface EditorProject {
	id: string;
	videoId: Video.VideoId;
	ownerId: User.UserId;
	config: ProjectConfiguration;
	createdAt: Date;
	updatedAt: Date;
}

export class VideoEditorProjects extends Effect.Service<VideoEditorProjects>()(
	"VideoEditorProjects",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;

			const getOrCreate = (
				videoId: Video.VideoId,
				ownerId: User.UserId,
				videoDuration: number,
			) =>
				Effect.gen(function* () {
					const maybeExisting = yield* db
						.use((db) =>
							db
								.select()
								.from(Db.videoEditorProjects)
								.where(
									Dz.and(
										Dz.eq(Db.videoEditorProjects.videoId, videoId),
										Dz.eq(Db.videoEditorProjects.ownerId, ownerId),
									),
								),
						)
						.pipe(Effect.map(Array.get(0)));

					if (Option.isSome(maybeExisting)) {
						const existing = maybeExisting.value;
						return {
							id: existing.id,
							videoId: existing.videoId as Video.VideoId,
							ownerId: existing.ownerId as User.UserId,
							config: normalizeStoredConfig(existing.config),
							createdAt: existing.createdAt,
							updatedAt: existing.updatedAt,
						} satisfies EditorProject;
					}

					const config = createDefaultConfig(videoDuration);
					const id = nanoId();

					yield* db.use((db) =>
						db.insert(Db.videoEditorProjects).values({
							id,
							videoId,
							ownerId,
							config,
						}),
					);

					const inserted = yield* db
						.use((db) =>
							db
								.select()
								.from(Db.videoEditorProjects)
								.where(Dz.eq(Db.videoEditorProjects.id, id)),
						)
						.pipe(Effect.map(Array.get(0)));

					if (Option.isSome(inserted)) {
						return {
							id: inserted.value.id,
							videoId: inserted.value.videoId as Video.VideoId,
							ownerId: inserted.value.ownerId as User.UserId,
							config: normalizeStoredConfig(inserted.value.config),
							createdAt: inserted.value.createdAt,
							updatedAt: inserted.value.updatedAt,
						} satisfies EditorProject;
					}

					return {
						id,
						videoId,
						ownerId,
						config,
						createdAt: new Date(),
						updatedAt: new Date(),
					} satisfies EditorProject;
				});

			const save = (
				videoId: Video.VideoId,
				ownerId: User.UserId,
				config: ProjectConfiguration,
			) =>
				db.use((db) =>
					db
						.update(Db.videoEditorProjects)
						.set({ config })
						.where(
							Dz.and(
								Dz.eq(Db.videoEditorProjects.videoId, videoId),
								Dz.eq(Db.videoEditorProjects.ownerId, ownerId),
							),
						),
				);

			const getByVideoId = (videoId: Video.VideoId, ownerId: User.UserId) =>
				db
					.use((db) =>
						db
							.select()
							.from(Db.videoEditorProjects)
							.where(
								Dz.and(
									Dz.eq(Db.videoEditorProjects.videoId, videoId),
									Dz.eq(Db.videoEditorProjects.ownerId, ownerId),
								),
							),
					)
					.pipe(
						Effect.map(Array.get(0)),
						Effect.map(
							Option.map(
								(p) =>
									({
										id: p.id,
										videoId: p.videoId as Video.VideoId,
										ownerId: p.ownerId as User.UserId,
										config: normalizeStoredConfig(p.config),
										createdAt: p.createdAt,
										updatedAt: p.updatedAt,
									}) satisfies EditorProject,
							),
						),
					);

			const deleteByVideoId = (videoId: Video.VideoId) =>
				db.use((db) =>
					db
						.delete(Db.videoEditorProjects)
						.where(Dz.eq(Db.videoEditorProjects.videoId, videoId)),
				);

			return {
				getOrCreate,
				save,
				getByVideoId,
				delete: deleteByVideoId,
			};
		}),
		dependencies: [Database.Default],
	},
) {}
