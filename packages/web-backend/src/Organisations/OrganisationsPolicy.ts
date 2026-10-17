import { type Organisation, Policy } from "@cap/web-domain";
import { Context, Effect, Layer, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";

const makeOrganisationsPolicy = Effect.gen(function* () {
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

	const isAdminOrOwner = (orgId: Organisation.OrganisationId) =>
		Policy.policy((user) =>
			repo.membership(user.id, orgId).pipe(
				Effect.map((v) =>
					v.pipe(
						Option.filter((v) => {
							const role = String(v.role).toLowerCase();
							return role === "owner" || role === "admin";
						}),
						Option.isSome,
					),
				),
			),
		);

	return { isMember, isOwner, isAdminOrOwner };
});

export class OrganisationsPolicy extends Context.Service<
	OrganisationsPolicy,
	Effect.Success<typeof makeOrganisationsPolicy>
>()("OrganisationsPolicy") {
	static readonly Default = Layer.effect(this, makeOrganisationsPolicy).pipe(
		Layer.provide(
			Layer.mergeAll(
				OrganisationsRepo.Default,
				SpacesRepo.Default,
				Database.Default,
			),
		),
	);
}
