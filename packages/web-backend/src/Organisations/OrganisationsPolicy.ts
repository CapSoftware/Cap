import { type Organisation, Policy } from "@cap/web-domain";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";

export class OrganisationsPolicy extends Effect.Service<OrganisationsPolicy>()(
	"OrganisationsPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* OrganisationsRepo;

			const isMember = (orgId: Organisation.OrganisationId) =>
				Policy.policy((user) =>
					repo.membership(user.id, orgId).pipe(Effect.map(Option.isSome)),
				);

			const isOwner = (orgId: Organisation.OrganisationId) =>
				Policy.policy((user) =>
					repo.membership(user.id, orgId).pipe(
						Effect.map((v) =>
							v.pipe(
								Option.filter((v) => v.role === "owner"),
								Option.isSome,
							),
						),
					),
				);

			return { isMember, isOwner };
		}),
		dependencies: [
			OrganisationsRepo.Default,
			SpacesRepo.Default,
			Database.Default,
		],
	},
) {}
