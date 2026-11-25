import type { Organisation, User } from "@cap/web-domain";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import type { db } from "./index.ts";
import { organizationMembers, organizations, users } from "./schema.ts";

type Client = Pick<ReturnType<typeof db>, "select" | "update">;

export type UsableOrganization = {
	id: Organisation.OrganisationId;
	name: string;
};

export async function findAccessibleOrganization(
	database: Client,
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
): Promise<UsableOrganization | null> {
	if (!organizationId) return null;
	const [organization] = await database
		.select({ id: organizations.id, name: organizations.name })
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, userId),
			),
		)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, userId),
					eq(organizationMembers.userId, userId),
				),
			),
		)
		.limit(1);
	return organization ?? null;
}

// Ordered so every resolver, and repeated requests, pick the same organization.
export async function findFallbackOrganization(
	database: Client,
	userId: User.UserId,
	excludeOrganizationId?: Organisation.OrganisationId,
): Promise<UsableOrganization | null> {
	const exclude = excludeOrganizationId
		? ne(organizations.id, excludeOrganizationId)
		: undefined;
	const [owned] = await database
		.select({ id: organizations.id, name: organizations.name })
		.from(organizations)
		.where(
			and(
				eq(organizations.ownerId, userId),
				isNull(organizations.tombstoneAt),
				exclude,
			),
		)
		.orderBy(asc(organizations.id))
		.limit(1);
	if (owned) return owned;

	const [joined] = await database
		.select({ id: organizations.id, name: organizations.name })
		.from(organizationMembers)
		.innerJoin(
			organizations,
			eq(organizations.id, organizationMembers.organizationId),
		)
		.where(
			and(
				eq(organizationMembers.userId, userId),
				isNull(organizations.tombstoneAt),
				exclude,
			),
		)
		.orderBy(asc(organizationMembers.createdAt), asc(organizations.id))
		.limit(1);
	return joined ?? null;
}

// The repair only applies while the pointer still holds the value that was
// checked, so a concurrent organization switch is not overwritten.
export async function resolveActiveOrganization(
	database: Client,
	user: {
		id: User.UserId;
		activeOrganizationId: Organisation.OrganisationId;
	},
): Promise<UsableOrganization | null> {
	const current = await findAccessibleOrganization(
		database,
		user.id,
		user.activeOrganizationId,
	);
	if (current) return current;

	const fallback = await findFallbackOrganization(database, user.id);
	if (fallback) {
		await database
			.update(users)
			.set({ activeOrganizationId: fallback.id })
			.where(
				and(
					eq(users.id, user.id),
					eq(users.activeOrganizationId, user.activeOrganizationId),
				),
			);
	}
	return fallback;
}
