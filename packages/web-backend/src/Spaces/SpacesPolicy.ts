import { Policy, type Space } from "@cap/web-domain";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";

export class SpacesPolicy extends Effect.Service<SpacesPolicy>()(
	"SpacesPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* SpacesRepo;

			const hasMembership = (spaceId: Space.SpaceIdOrOrganisationId) =>
				Policy.policy((user) =>
					repo.membership(user.id, spaceId).pipe(Effect.map(Option.isSome)),
				);

			// spaces.createdById survives the creator's removal from the
			// organization, so creator access also needs current membership.
			const isOwner = (spaceId: Space.SpaceIdOrOrganisationId) =>
				Policy.policy((user) =>
					repo
						.creatorWithOrganizationAccess(user.id, spaceId)
						.pipe(Effect.map(Option.isSome)),
				);

			const isMember = (spaceId: Space.SpaceIdOrOrganisationId) =>
				Policy.any(isOwner(spaceId), hasMembership(spaceId));

			const isAdmin = (spaceId: Space.SpaceIdOrOrganisationId) =>
				Policy.any(
					isOwner(spaceId),
					Policy.policy((user) =>
						repo.membership(user.id, spaceId).pipe(
							Effect.map((v) =>
								v.pipe(
									Option.filter(
										(v) => String(v.role).toLowerCase() === "admin",
									),
									Option.isSome,
								),
							),
						),
					),
				);

			return { isMember, isOwner, isAdmin };
		}),
		dependencies: [
			OrganisationsRepo.Default,
			SpacesRepo.Default,
			Database.Default,
		],
	},
) {}
