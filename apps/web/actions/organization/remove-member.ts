"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
export async function removeOrganizationMember(
	memberId: string,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [organization] = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization) {
		throw new Error("Organization not found");
	}

	const [ownerMembership] = await db()
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.userId, user.id),
				eq(organizationMembers.role, "owner"),
			),
		)
		.limit(1);

	if (!ownerMembership) {
		throw new Error("Only the owner can remove organization members");
	}

	const [member] = await db()
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.id, memberId),
				eq(organizationMembers.organizationId, organizationId),
			),
		)
		.limit(1);
	if (!member) {
		throw new Error("Member not found");
	}
	if (member.userId === user.id) {
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
