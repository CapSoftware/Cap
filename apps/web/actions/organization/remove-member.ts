"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationInvites,
	organizationMembers,
	spaceMembers,
	spaces,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
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

	const [member] = await db()
		.select({
			id: organizationMembers.id,
			userId: organizationMembers.userId,
			role: organizationMembers.role,
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
		.limit(1);

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

	await db().transaction(async (tx) => {
		const organizationSpaces = await tx
			.select({ id: spaces.id })
			.from(spaces)
			.where(eq(spaces.organizationId, organizationId));
		const spaceIds = organizationSpaces.map((space) => space.id);

		if (spaceIds.length > 0) {
			await tx
				.delete(spaceMembers)
				.where(
					and(
						eq(spaceMembers.userId, member.userId),
						inArray(spaceMembers.spaceId, spaceIds),
					),
				);
		}

		await tx
			.delete(organizationInvites)
			.where(
				and(
					eq(organizationInvites.organizationId, organizationId),
					eq(organizationInvites.invitedEmail, member.email.toLowerCase()),
				),
			);

		const [result] = await tx
			.delete(organizationMembers)
			.where(
				and(
					eq(organizationMembers.id, memberId),
					eq(organizationMembers.organizationId, organizationId),
				),
			);

		if (result.affectedRows === 0) throw new Error("Member not found");
	});

	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard");
	return { success: true };
}
