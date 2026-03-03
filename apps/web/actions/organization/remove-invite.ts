"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationInvites,
	organizationMembers,
	organizations,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeOrganizationInvite(
	inviteId: string,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const [organization] = await db()
		.select()
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
		throw new Error("Only the owner can remove organization invites");
	}

	const [result] = await db()
		.delete(organizationInvites)
		.where(
			and(
				eq(organizationInvites.id, inviteId),
				eq(organizationInvites.organizationId, organizationId),
			),
		);

	if (result.affectedRows === 0) throw new Error("Invite not found");

	revalidatePath("/dashboard/settings/organization");

	return { success: true };
}
