import type { db } from "@cap/database";
import { releaseProSeatSubscription } from "@cap/database/pro-seat-subscription";
import {
	organizationInvites,
	organizationMembers,
	spaceMembers,
	spaces,
} from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
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
}
