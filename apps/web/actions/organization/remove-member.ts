"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Remove a member from an organization. Only the owner can perform this action.
 * @param memberId The organizationMembers.id to remove
 * @param organizationId The organization to remove from
 */
export async function removeOrganizationMember(
	memberId: string,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const organization = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization || organization.length === 0) {
		throw new Error("Organization not found");
	}
	if (organization[0]?.ownerId !== user.id) {
		throw new Error("Only the owner can remove organization members");
	}

	// Prevent owner from removing themselves
	const member = await db()
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.id, memberId),
				eq(organizationMembers.organizationId, organizationId),
			),
		)
		.limit(1);
	if (!member || member.length === 0) {
		throw new Error("Member not found");
	}
	if (member[0]?.userId === user.id) {
		// Defensive: this should never happen due to the above check, but TS wants safety
		throw new Error("Owner cannot remove themselves");
	}

	const [result] = await db()
		.delete(organizationMembers)
		.where(
			and(
				eq(organizationMembers.id, memberId),
				eq(organizationMembers.organizationId, organizationId),
			),
		);

	if (result.affectedRows === 0) throw new Error("Member not found");

	revalidatePath("/dashboard/settings/organization");
	return { success: true };
}
