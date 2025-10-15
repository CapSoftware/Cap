import * as Db from "@cap/database/schema";
import { type Organisation, Policy, type Space } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database.ts";
import { OrganisationsPolicy } from "../Organisations/OrganisationsPolicy.ts";
import { SpacesPolicy } from "./SpacesPolicy.ts";

export class Spaces extends Effect.Service<Spaces>()("Spaces", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const spacesPolicy = yield* SpacesPolicy;
		const orgsPolicy = yield* OrganisationsPolicy;

		// this sucks but right now org ids are also valid space ids,
		// since the whole-org space is just the org id
		const getSpaceOrOrg = Effect.fn(function* (
			spaceOrOrgId: Space.SpaceIdOrOrganisationId,
		) {
			const [[space], [org]] = yield* Effect.all([
				db.use((db) =>
					db
						.select({
							id: Db.spaces.id,
							name: Db.spaces.name,
							organizationId: Db.spaces.organizationId,
							createdById: Db.spaces.createdById,
						})
						.from(Db.spaces)
						.where(Dz.eq(Db.spaces.id, spaceOrOrgId))
						.limit(1),
				),
				db.use((db) =>
					db
						.select({
							id: Db.organizations.id,
							name: Db.organizations.name,
							ownerId: Db.organizations.ownerId,
						})
						.from(Db.organizations)
						.where(
							Dz.eq(
								Db.organizations.id,
								spaceOrOrgId as Organisation.OrganisationId,
							),
						)
						.limit(1),
				),
			]);
			if (space)
				return yield* Effect.succeed({ variant: "space" as const, space }).pipe(
					Policy.withPolicy(spacesPolicy.isMember(space.id)),
				);
			if (org)
				return yield* Effect.succeed({
					variant: "organization" as const,
					organization: org,
				}).pipe(Policy.withPolicy(orgsPolicy.isMember(org.id)));
		});

		return { getSpaceOrOrg };
	}),
	dependencies: [
		SpacesPolicy.Default,
		OrganisationsPolicy.Default,
		Database.Default,
	],
}) {}
