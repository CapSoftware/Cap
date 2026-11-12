import { type Folder, Policy, type Space } from "@cap/web-domain";
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
			const getManagedOrganizationId = (
				spaceId: Space.SpaceIdOrOrganisationId,
			) =>
				Effect.gen(function* () {
					const spaceOrOrg = yield* spaces.getSpaceOrOrg(spaceId);
					if (!spaceOrOrg) return;

					if (spaceOrOrg.variant === "space") {
						yield* Policy.any(
							spacesPolicy.isAdmin(spaceOrOrg.space.id),
							orgsPolicy.isAdminOrOwner(spaceOrOrg.space.organizationId),
						);
					} else {
						yield* orgsPolicy.isAdminOrOwner(spaceOrOrg.organization.id);
					}

					return spaceOrOrg.variant === "space"
						? spaceOrOrg.space.organizationId
						: spaceOrOrg.organization.id;
				});

			const canEdit = (id: Folder.FolderId) =>
				Policy.policy((user) =>
					Effect.gen(function* () {
						const folder = yield* (yield* repo.getById(id)).pipe(
							Effect.catchTag("NoSuchElementException", () =>
								Effect.fail(new Policy.PolicyDeniedError()),
							),
						);

						if (folder.spaceId === null) return folder.createdById === user.id;

						return Boolean(yield* getManagedOrganizationId(folder.spaceId));
					}),
				);

			const canCreateIn = (spaceId: Space.SpaceIdOrOrganisationId) =>
				Policy.policy((user) =>
					getManagedOrganizationId(spaceId).pipe(
						Effect.map(
							(organizationId) => organizationId === user.activeOrganizationId,
						),
					),
				);

			return { canEdit, canCreateIn };
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
