import { Policy } from "@cap/web-domain";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";

export class OrganisationsPolicy extends Effect.Service<OrganisationsPolicy>()(
	"OrganisationsPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* OrganisationsRepo;

			const isMember = (orgId: string) =>
				Policy.policy(
					Effect.fn(function* (user) {
						return Option.isSome(yield* repo.membership(user.id, orgId));
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
