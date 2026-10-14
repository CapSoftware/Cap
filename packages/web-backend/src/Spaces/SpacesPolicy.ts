import { Policy, type Space } from "@cap/web-domain";
import { Context, Effect, Layer, Option } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsRepo } from "../Organisations/OrganisationsRepo.ts";
import { SpacesRepo } from "../Spaces/SpacesRepo.ts";

const makeSpacesPolicy = Effect.gen(function* () {
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

	const isAdmin = (spaceId: Space.SpaceIdOrOrganisationId) =>
		Policy.any(
			isOwner(spaceId),
			Policy.policy((user) =>
				repo.membership(user.id, spaceId).pipe(
					Effect.map((v) =>
						v.pipe(
							Option.filter((v) => String(v.role).toLowerCase() === "admin"),
							Option.isSome,
						),
					),
				),
			),
		);

	return { isMember, isOwner, isAdmin };
});

export class SpacesPolicy extends Context.Service<
	SpacesPolicy,
	Effect.Success<typeof makeSpacesPolicy>
>()("SpacesPolicy") {
	static readonly Default = Layer.effect(this, makeSpacesPolicy).pipe(
		Layer.provide(
			Layer.mergeAll(
				OrganisationsRepo.Default,
				SpacesRepo.Default,
				Database.Default,
			),
		),
	);
}
