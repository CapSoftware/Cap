import * as Db from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database.ts";

export class OrganisationsRepo extends Effect.Service<OrganisationsRepo>()(
	"OrganisationsRepo",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;

			return {
				membershipForVideo: (userId: string, videoId: Video.VideoId) =>
					db.execute((db) =>
						db
							.select({ membershipId: Db.organizationMembers.id })
							.from(Db.organizationMembers)
							.leftJoin(
								Db.sharedVideos,
								Dz.eq(
									Db.organizationMembers.organizationId,
									Db.sharedVideos.organizationId,
								),
							)
							.where(
								Dz.and(
									Dz.eq(Db.organizationMembers.userId, userId),
									Dz.eq(Db.sharedVideos.videoId, videoId),
								),
							),
					),
			};
		}),
		dependencies: [Database.Default],
	},
) {}
