import { Policy, Space } from "@cap/web-domain";
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

			const isOwner = (spaceId: Space.SpaceIdOrOrganisationId) =>
				Policy.policy(
					Effect.fn(function* (user) {
						const space = yield* repo.getById(spaceId);
						if (Option.isNone(space)) return false;

						return space.value.createdById === user.id;
					}),
				);

			const isMember = (spaceId: Space.SpaceIdOrOrganisationId) =>
				Policy.any(isOwner(spaceId), hasMembership(spaceId));

			return { isMember, isOwner };
		}),
		dependencies: [
			OrganisationsRepo.Default,
			SpacesRepo.Default,
			Database.Default,
		],
	},
) {}
