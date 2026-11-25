import type { db } from "@cap/database";
import { findFallbackOrganization } from "@cap/database/organization-pointer";
import { releaseProSeatSubscription } from "@cap/database/pro-seat-subscription";
import {
	organizationInvites,
	organizationMembers,
	spaceMembers,
	spaces,
	users,
} from "@cap/database/schema";
import { Organisation, type User } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export async function deleteOrganizationMembership(
	tx: Transaction,
	organizationId: Organisation.OrganisationId,
	member: {
		id: string;
		userId: User.UserId;
		hasProSeat: boolean;
		email: string;
	},
) {
	const [result] = await tx
		.delete(organizationMembers)
		.where(
			and(
				eq(organizationMembers.id, member.id),
				eq(organizationMembers.organizationId, organizationId),
			),
		);

	if (result.affectedRows === 0) throw new Error("Member not found");

	if (member.hasProSeat) {
		await releaseProSeatSubscription(tx, member.userId);
	}

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

	await moveOrganizationPointersAway(tx, organizationId, member.userId);
}

async function moveOrganizationPointersAway(
	tx: Transaction,
	organizationId: Organisation.OrganisationId,
	userId: User.UserId,
) {
	const [user] = await tx
		.select({
			activeOrganizationId: users.activeOrganizationId,
			defaultOrgId: users.defaultOrgId,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (
		!user ||
		(user.activeOrganizationId !== organizationId &&
			user.defaultOrgId !== organizationId)
	)
		return;

	const fallback =
		(await findFallbackOrganization(tx, userId, organizationId))?.id ?? null;

	await tx
		.update(users)
		.set({
			...(user.activeOrganizationId === organizationId
				? {
						activeOrganizationId:
							fallback ?? Organisation.OrganisationId.make(""),
					}
				: {}),
			...(user.defaultOrgId === organizationId
				? { defaultOrgId: fallback }
				: {}),
		})
		.where(eq(users.id, userId));
}
