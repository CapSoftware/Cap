"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	users,
	organizations,
	organizationMembers,
} from "@cap/database/schema";
import { eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function patchAccountSettings(
	firstName?: string,
	lastName?: string,
	defaultOrgId?: string,
) {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	// If defaultOrgId is being updated, verify user has access to that organization
	if (defaultOrgId) {
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
	}

	await db()
		.update(users)
		.set({
			name: firstName,
			lastName,
			defaultOrgId,
		})
		.where(eq(users.id, currentUser.id));

	revalidatePath("/dashboard/settings/account");
}
