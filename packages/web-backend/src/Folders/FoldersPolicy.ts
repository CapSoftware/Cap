import * as Db from "@cap/database/schema";
import { type Folder, Policy } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database.ts";

export class FoldersPolicy extends Effect.Service<FoldersPolicy>()(
	"FoldersPolicy",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;

			const canEdit = (id: Folder.FolderId) =>
				Policy.policy((user) =>
					Effect.gen(function* () {
						const [folder] = yield* db.execute((db) =>
							db.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)),
						);

						// All space members can edit space properties
						if (!folder?.spaceId) {
							return folder?.createdById === user.id;
						}

						const { spaceId } = folder;
						const [spaceMember] = yield* db.execute((db) =>
							db
								.select()
								.from(Db.spaceMembers)
								.where(
									Dz.and(
										Dz.eq(Db.spaceMembers.userId, user.id),
										Dz.eq(Db.spaceMembers.spaceId, spaceId),
									),
								),
						);

						return spaceMember !== undefined;
					}),
				);

			return { canEdit };
		}),
		dependencies: [Database.Default],
	},
) {}
