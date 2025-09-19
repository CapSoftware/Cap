import * as Db from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database.ts";

export class SpacesRepo extends Effect.Service<SpacesRepo>()("SpacesRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		return {
			membershipForVideo: (userId: string, videoId: Video.VideoId) =>
				db.execute((db) =>
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
				),
		};
	}),
	dependencies: [Database.Default],
}) {}
