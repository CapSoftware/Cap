import { type Folder, Policy } from "@cap/web-domain";
import { Effect } from "effect";

import { Database } from "../Database.ts";
import { SpacesPolicy } from "../Spaces/SpacesPolicy.ts";
import { FoldersRepo } from "./FoldersRepo.ts";

export class FoldersPolicy extends Effect.Service<FoldersPolicy>()(
	"FoldersPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* FoldersRepo;
			const spacesPolicy = yield* SpacesPolicy;

			const canEdit = (id: Folder.FolderId) =>
				Policy.policy((user) =>
					Effect.gen(function* () {
						const folder = yield* (yield* repo.getById(id)).pipe(
							Effect.catchTag(
								"NoSuchElementException",
								() => new Policy.PolicyDeniedError(),
							),
						);

						if (folder.spaceId === null) return folder.createdById === user.id;

						yield* spacesPolicy.isMember(folder.spaceId);

						return true;
					}),
				);

			return { canEdit };
		}),
		dependencies: [Database.Default],
	},
) {}
