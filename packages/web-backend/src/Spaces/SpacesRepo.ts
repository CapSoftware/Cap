import * as Db from "@inflight/database/schema";
import type { Space, User, Video } from "@inflight/web-domain";
import * as Dz from "drizzle-orm";
import { Array, Effect } from "effect";

import { Database } from "../Database.ts";

export class SpacesRepo extends Effect.Service<SpacesRepo>()("SpacesRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		return {
			membershipForVideo: (userId: User.UserId, videoId: Video.VideoId) =>
				db
					.use((db) =>
						db
							.select({ membershipId: Db.spaceMembers.id })
							.from(Db.spaceMembers)
							.leftJoin(
								Db.spaceVideos,
								Dz.eq(Db.spaceMembers.spaceId, Db.spaceVideos.spaceId),
							)
							.where(
								Dz.and(
									Dz.eq(Db.spaceMembers.userId, userId),
									Dz.eq(Db.spaceVideos.videoId, videoId),
								),
							),
					)
					.pipe(Effect.map(Array.get(0))),

			membership: (
				userId: User.UserId,
				spaceId: Space.SpaceIdOrOrganisationId,
			) =>
				db
					.use((db) =>
						db
							.select({
								membershipId: Db.spaceMembers.id,
								role: Db.spaceMembers.role,
							})
							.from(Db.spaceMembers)
							.where(
								Dz.and(
									Dz.eq(Db.spaceMembers.userId, userId),
									Dz.eq(Db.spaceMembers.spaceId, spaceId),
								),
							),
					)
					.pipe(Effect.map(Array.get(0))),

			getById: (spaceId: Space.SpaceIdOrOrganisationId) =>
				db
					.use((db) =>
						db.select().from(Db.spaces).where(Dz.eq(Db.spaces.id, spaceId)),
					)
					.pipe(Effect.map(Array.get(0))),
		};
	}),
	dependencies: [Database.Default],
}) {}
