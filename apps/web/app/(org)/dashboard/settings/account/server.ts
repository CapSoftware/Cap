"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
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

	const updatePayload: Partial<{
		name: string;
		lastName: string;
		defaultOrgId: string;
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
