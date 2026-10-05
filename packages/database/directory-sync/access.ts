import type { Organisation, User } from "@cap/web-domain";
import { and, eq, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { db } from "../index";
import { directoryUsers, organizationDirectorySync, spaces } from "../schema";

export type DirectoryReader = Pick<ReturnType<typeof db>, "select">;

export function directoryAccessAllowed(
	userId: string | SQLWrapper,
	organizationId: string | SQLWrapper,
) {
	const predicate = sql<boolean>`NOT EXISTS (
		SELECT 1 FROM ${directoryUsers}
		INNER JOIN ${organizationDirectorySync}
		ON ${organizationDirectorySync.organizationId} = ${directoryUsers.organizationId}
		WHERE ${directoryUsers.organizationId} = ${organizationId}
		AND ${directoryUsers.userId} = ${userId}
		AND (${directoryUsers.state} <> 'active' OR ${organizationDirectorySync.state} IN ('deleted', 'inactive'))
	)`;
	// Drizzle strips direct column qualifiers in single-table selections.
	return sql<boolean>`(${predicate})`;
}

export async function hasDirectoryAccess(
	userId: string,
	organizationId: Organisation.OrganisationId,
	database: DirectoryReader = db(),
) {
	const [record] = await database
		.select({ allowed: directoryAccessAllowed(userId, organizationId) })
		.from(organizationDirectorySync)
		.where(eq(organizationDirectorySync.organizationId, organizationId))
		.limit(1);
	return !record || Boolean(record.allowed);
}

export function directorySpaceAccessAllowed(
	userId: string | SQLWrapper,
	spaceId: string | SQLWrapper,
) {
	const directorySpace = alias(spaces, "directory_access_space");
	return sql<boolean>`NOT EXISTS (SELECT 1 FROM ${spaces} AS ${sql.identifier("directory_access_space")} WHERE ${directorySpace.id} = ${spaceId} AND NOT (${directoryAccessAllowed(userId, directorySpace.organizationId)}))`;
}

export async function requireDirectoryMembership(
	database: DirectoryReader,
	organizationId: Organisation.OrganisationId,
	email: string,
	userId?: User.UserId,
) {
	const [configuration] = await database
		.select()
		.from(organizationDirectorySync)
		.where(eq(organizationDirectorySync.organizationId, organizationId))
		.limit(1);
	if (!configuration?.directoryId) return;
	const [member] = await database
		.select({ state: directoryUsers.state, userId: directoryUsers.userId })
		.from(directoryUsers)
		.where(
			and(
				eq(directoryUsers.organizationId, organizationId),
				eq(directoryUsers.directoryId, configuration.directoryId),
				eq(directoryUsers.email, email.trim().toLowerCase()),
			),
		)
		.limit(1);
	if (
		configuration.state !== "active" ||
		member?.state !== "active" ||
		!member.userId ||
		(userId && member.userId !== userId)
	) {
		throw new Error(
			"Your organization must assign you to Cap through its identity provider.",
		);
	}
}
