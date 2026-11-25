import type { db } from "@cap/database";
import { releaseProSeatSubscription } from "@cap/database/pro-seat-subscription";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	users,
} from "@cap/database/schema";
import { Organisation, type User } from "@cap/web-domain";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

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

	const [owned] = await tx
		.select({ id: organizations.id })
		.from(organizations)
		.where(
			and(
				eq(organizations.ownerId, userId),
				ne(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	const [joined] = owned
		? []
		: await tx
				.select({ id: organizations.id })
				.from(organizationMembers)
				.innerJoin(
					organizations,
					eq(organizations.id, organizationMembers.organizationId),
				)
				.where(
					and(
						eq(organizationMembers.userId, userId),
						ne(organizations.id, organizationId),
						isNull(organizations.tombstoneAt),
					),
				)
				.limit(1);
	const fallback = owned?.id ?? joined?.id ?? null;

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
