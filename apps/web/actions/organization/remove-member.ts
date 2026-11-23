"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, users } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { deleteOrganizationMembership } from "@/lib/organization-member-removal";
import {
	canRemoveOrganizationMember,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { requireOrganizationSettingsManager } from "./authorization";

export async function removeOrganizationMember(
	memberId: string,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const actor = await requireOrganizationSettingsManager(
		user.id,
		organizationId,
	);

	await db().transaction(async (tx) => {
		const [member] = await tx
			.select({
				id: organizationMembers.id,
				userId: organizationMembers.userId,
				role: organizationMembers.role,
				hasProSeat: organizationMembers.hasProSeat,
				email: users.email,
			})
			.from(organizationMembers)
			.innerJoin(users, eq(organizationMembers.userId, users.id))
			.where(
				and(
					eq(organizationMembers.id, memberId),
					eq(organizationMembers.organizationId, organizationId),
				),
			)
			.limit(1)
			.for("update");

		if (!member) {
			throw new Error("Member not found");
		}

		const targetRole = getEffectiveOrganizationRole({
			userId: member.userId,
			ownerId: actor.ownerId,
			memberRole: member.role,
		});

		if (
			!canRemoveOrganizationMember({
				actorRole: actor.role,
				actorUserId: user.id,
				targetUserId: member.userId,
				ownerId: actor.ownerId,
				targetRole,
			})
		) {
			throw new Error("You do not have permission to remove this member");
		}

		await deleteOrganizationMembership(tx, organizationId, member);
	});

	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard");
	return { success: true };
}
