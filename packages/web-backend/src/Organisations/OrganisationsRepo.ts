import * as Db from "@cap/database/schema";
import type { Organisation, User, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Array, Effect, Option } from "effect";

import { Database } from "../Database.ts";

export class OrganisationsRepo extends Effect.Service<OrganisationsRepo>()(
	"OrganisationsRepo",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;

			return {
				membershipForVideo: (userId: User.UserId, videoId: Video.VideoId) =>
					db.use((db) =>
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
				membership: (userId: User.UserId, orgId: Organisation.OrganisationId) =>
					db
						.use((db) =>
							db
								.select({
									membershipId: Db.organizationMembers.id,
									role: Db.organizationMembers.role,
								})
								.from(Db.organizationMembers)
								.where(
									Dz.and(
										Dz.eq(Db.organizationMembers.userId, userId),
										Dz.eq(Db.organizationMembers.organizationId, orgId),
									),
								),
						)
						.pipe(Effect.map(Array.get(0))),
				allowedEmailDomain: (orgId: Organisation.OrganisationId) =>
					db
						.use((db) =>
							db
								.select({
									allowedEmailDomain: Db.organizations.allowedEmailDomain,
								})
								.from(Db.organizations)
								.where(Dz.eq(Db.organizations.id, orgId))
								.limit(1),
						)
						.pipe(
							Effect.map(Array.get(0)),
							Effect.map(
								Option.flatMap((row) =>
									Option.fromNullable(row.allowedEmailDomain?.trim() || null),
								),
							),
						),
			};
		}),
		dependencies: [Database.Default],
	},
) {}
