import { Policy } from "@cap/web-domain";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";

export class SpacesPolicy extends Effect.Service<SpacesPolicy>()(
	"SpacesPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* SpacesRepo;

			const hasMembership = (spaceId: string) =>
				Policy.policy(
					Effect.fn(function* (user) {
						return Option.isSome(yield* repo.membership(user.id, spaceId));
					}),
				);

			const isOwner = (spaceId: string) =>
				Policy.policy(
					Effect.fn(function* (user) {
						const space = yield* repo.getById(spaceId);

						if (Option.isNone(space)) {
							yield* Effect.log("Space not found. Access granted.");
							return true;
						}

						return space.value.createdById === user.id;
					}),
				);

			const isMember = (spaceId: string) =>
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
