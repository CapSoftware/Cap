"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	canChangeOrganizationMemberRole,
	getEffectiveOrganizationRole,
	normalizeAssignableOrganizationRole,
} from "@/lib/permissions/roles";
import { requireOrganizationSettingsManager } from "./authorization";

export async function updateOrganizationMemberRole(
	memberId: string,
	organizationId: Organisation.OrganisationId,
	roleInput: string,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const nextRole = normalizeAssignableOrganizationRole(roleInput);
	if (!nextRole) throw new Error("Invalid organization role");

	const actor = await requireOrganizationSettingsManager(
		user.id,
		organizationId,
	);

	const [member] = await db()
		.select({
			id: organizationMembers.id,
			userId: organizationMembers.userId,
			role: organizationMembers.role,
		})
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.id, memberId),
				eq(organizationMembers.organizationId, organizationId),
			),
		)
		.limit(1);

	if (!member) throw new Error("Member not found");

	const targetRole = getEffectiveOrganizationRole({
		userId: member.userId,
		ownerId: actor.ownerId,
		memberRole: member.role,
	});

	if (
		!canChangeOrganizationMemberRole({
			actorRole: actor.role,
			actorUserId: user.id,
			targetUserId: member.userId,
			ownerId: actor.ownerId,
			targetRole,
			nextRole,
		})
	) {
		throw new Error("You do not have permission to update this member role");
	}

	await db()
		.update(organizationMembers)
		.set({ role: nextRole })
		.where(eq(organizationMembers.id, memberId));

	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard");

	return { success: true };
}
