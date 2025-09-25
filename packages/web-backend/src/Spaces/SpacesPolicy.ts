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

			const isMember = (spaceId: string) =>
				Policy.policy(
					Effect.fn(function* (user) {
						return Option.isSome(yield* repo.membership(user.id, spaceId));
					}),
				);

			return { isMember };
		}),
		dependencies: [
			OrganisationsRepo.Default,
			SpacesRepo.Default,
			Database.Default,
		],
	},
) {}
