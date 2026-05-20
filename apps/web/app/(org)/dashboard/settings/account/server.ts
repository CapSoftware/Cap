"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	authApiKeys,
	organizationMembers,
	organizations,
	sessions,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { eq, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function patchAccountSettings(
	firstName?: string,
	lastName?: string,
	defaultOrgId?: Organisation.OrganisationId,
) {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	const updatePayload: Partial<{
		name: string;
		lastName: string;
		defaultOrgId: Organisation.OrganisationId;
	}> = {};

	if (firstName !== undefined) updatePayload.name = firstName;
	if (lastName !== undefined) updatePayload.lastName = lastName;
	if (defaultOrgId !== undefined) {
		const userOrganizations = await db()
			.select({
				id: organizations.id,
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.where(
				or(
					// User owns the organization
					eq(organizations.ownerId, currentUser.id),
					// User is a member of the organization
					eq(organizationMembers.userId, currentUser.id),
				),
			)
			// Remove duplicates if user is both owner and member
			.groupBy(organizations.id);

		const userOrgIds = userOrganizations.map((org) => org.id);

		if (!userOrgIds.includes(defaultOrgId))
			throw new Error(
				"Forbidden: User does not have access to the specified organization",
			);

		updatePayload.defaultOrgId = defaultOrgId;
	}

	await db()
		.update(users)
		.set(updatePayload)
		.where(eq(users.id, currentUser.id));

	revalidatePath("/dashboard/settings/account");
}

export async function signOutAllDevices() {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	await db().transaction(async (tx) => {
		await tx
			.update(users)
			.set({ authSessionVersion: sql`${users.authSessionVersion} + 1` })
			.where(eq(users.id, currentUser.id));
		await tx.delete(sessions).where(eq(sessions.userId, currentUser.id));
		await tx.delete(authApiKeys).where(eq(authApiKeys.userId, currentUser.id));
	});
}
