import { organizations, spaces } from "@cap/database/schema";
import { Database, OrganisationsPolicy, SpacesPolicy } from "@cap/web-backend";
import { Policy } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

export const getSpaceOrOrg = Effect.fn(function* (spaceOrOrgId: string) {
	const db = yield* Database;
	const spacesPolicy = yield* SpacesPolicy;
	const orgsPolicy = yield* OrganisationsPolicy;

	const [[space], [organization]] = yield* Effect.all([
		db.execute((db) =>
			db
				.select({
					id: spaces.id,
					name: spaces.name,
					organizationId: spaces.organizationId,
					createdById: spaces.createdById,
				})
				.from(spaces)
				.where(eq(spaces.id, spaceOrOrgId))
				.limit(1),
		),
		db.execute((db) =>
			db
				.select({
					id: organizations.id,
					name: organizations.name,
					ownerId: organizations.ownerId,
				})
				.from(organizations)
				.where(eq(organizations.id, spaceOrOrgId))
				.limit(1),
		),
	]);

	if (space)
		return yield* Effect.succeed({ variant: "space" as const, space }).pipe(
			Policy.withPolicy(spacesPolicy.isMember(space.id)),
		);

	if (organization)
		return yield* Effect.succeed({
			variant: "organization" as const,
			organization,
		}).pipe(Policy.withPolicy(orgsPolicy.isMember(organization.id)));
});
