import { type Folder, Policy } from "@inflight/web-domain";
import { Effect } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsPolicy } from "../Organisations/OrganisationsPolicy.ts";
import { Spaces } from "../Spaces/index.ts";
import { SpacesPolicy } from "../Spaces/SpacesPolicy.ts";
import { FoldersRepo } from "./FoldersRepo.ts";

export class FoldersPolicy extends Effect.Service<FoldersPolicy>()(
	"FoldersPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* FoldersRepo;
			const spacesPolicy = yield* SpacesPolicy;
			const orgsPolicy = yield* OrganisationsPolicy;
			const spaces = yield* Spaces;

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

						const spaceOrOrg = yield* spaces.getSpaceOrOrg(folder.spaceId);
						if (!spaceOrOrg) return false;

						if (spaceOrOrg.variant === "space")
							yield* spacesPolicy.isMember(spaceOrOrg.space.id);
						else yield* orgsPolicy.isOwner(spaceOrOrg.organization.id);

						return true;
					}),
				);

			return { canEdit };
		}),
		dependencies: [
			FoldersRepo.Default,
			Database.Default,
			Spaces.Default,
			SpacesPolicy.Default,
			OrganisationsPolicy.Default,
		],
	},
) {}
