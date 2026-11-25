import { Organisation, type User } from "@cap/web-domain";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { nanoId } from "./helpers.ts";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "./schema.ts";

type Database = MySql2Database;
type Client = Pick<Database, "select" | "update">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const PERSONAL_ORGANIZATION_NAME = "My Organization";

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

export async function insertPersonalOrganization(
	tx: Transaction,
	userId: User.UserId,
): Promise<UsableOrganization> {
	const organizationId = Organisation.OrganisationId.make(nanoId());
	await tx.insert(organizations).values({
		id: organizationId,
		ownerId: userId,
		name: PERSONAL_ORGANIZATION_NAME,
	});
	await tx.insert(organizationMembers).values({
		id: nanoId(),
		organizationId,
		userId,
		role: "owner",
	});
	await tx
		.update(users)
		.set({
			activeOrganizationId: organizationId,
			defaultOrgId: organizationId,
		})
		.where(eq(users.id, userId));
	return { id: organizationId, name: PERSONAL_ORGANIZATION_NAME };
}

// Locking the user row first makes concurrent callers (two tabs, extension and
// web at once) queue here, and the checks below then read what the first one
// committed, so only one personal organization is created.
export async function ensurePersonalOrganization(
	database: Database,
	userId: User.UserId,
): Promise<UsableOrganization | null> {
	return database.transaction(async (tx) => {
		const [user] = await tx
			.select({ activeOrganizationId: users.activeOrganizationId })
			.from(users)
			.where(eq(users.id, userId))
			.for("update");
		if (!user) return null;

		const current = await findAccessibleOrganization(
			tx,
			userId,
			user.activeOrganizationId,
		);
		if (current) return current;

		const existing = await findFallbackOrganization(tx, userId);
		if (existing) {
			await tx
				.update(users)
				.set({ activeOrganizationId: existing.id })
				.where(eq(users.id, userId));
			return existing;
		}

		return insertPersonalOrganization(tx, userId);
	});
}

export async function resolveOrCreateActiveOrganization(
	database: Database,
	user: {
		id: User.UserId;
		activeOrganizationId: Organisation.OrganisationId;
	},
): Promise<UsableOrganization | null> {
	return (
		(await resolveActiveOrganization(database, user)) ??
		(await ensurePersonalOrganization(database, user.id))
	);
}

export async function findPendingOrganizationInviteId(
	database: Client,
	email: string,
): Promise<string | null> {
	const [invite] = await database
		.select({ id: organizationInvites.id })
		.from(organizationInvites)
		.where(
			and(
				eq(organizationInvites.invitedEmail, email.toLowerCase()),
				eq(organizationInvites.status, "pending"),
			),
		)
		.limit(1);
	return invite?.id ?? null;
}

export async function readActiveOrganizationId(
	database: Client,
	userId: User.UserId,
): Promise<Organisation.OrganisationId | null> {
	const [user] = await database
		.select({ activeOrganizationId: users.activeOrganizationId })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return user?.activeOrganizationId ?? null;
}
