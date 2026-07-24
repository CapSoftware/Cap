import "server-only";

import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { type Organisation, User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import {
	calculateProSeats,
	hasActiveDirectSubscription,
} from "@/utils/organization";

type ProvisionOrganizationRole = "admin" | "member";

function getProvisionedUserName(email: string) {
	return (
		email
			.split("@")[0]
			?.replace(/[._-]+/g, " ")
			.trim() || email
	);
}

export async function provisionOrganizationInvitee({
	organizationId,
	email,
	invitedByUserId,
	role,
}: {
	organizationId: Organisation.OrganisationId;
	email: string;
	invitedByUserId: User.UserId;
	role: ProvisionOrganizationRole;
}) {
	const normalizedEmail = email.trim().toLowerCase();

	return db().transaction(async (tx) => {
		const [existingUser] = await tx
			.select()
			.from(users)
			.where(eq(users.email, normalizedEmail))
			.limit(1);

		const userId = existingUser?.id ?? User.UserId.make(nanoId());

		if (existingUser) {
			const userUpdate: Partial<typeof users.$inferInsert> = {};

			if (!existingUser.name) {
				userUpdate.name = getProvisionedUserName(normalizedEmail);
			}
			if (!existingUser.activeOrganizationId) {
				userUpdate.activeOrganizationId = organizationId;
			}
			if (!existingUser.defaultOrgId) {
				userUpdate.defaultOrgId = organizationId;
			}

			if (Object.keys(userUpdate).length > 0) {
				await tx.update(users).set(userUpdate).where(eq(users.id, userId));
			}
		} else {
			await tx.insert(users).values({
				id: userId,
				email: normalizedEmail,
				name: getProvisionedUserName(normalizedEmail),
				activeOrganizationId: organizationId,
				defaultOrgId: organizationId,
			});
		}

		const [existingMember] = await tx
			.select({
				id: organizationMembers.id,
				hasProSeat: organizationMembers.hasProSeat,
			})
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, organizationId),
					eq(organizationMembers.userId, userId),
				),
			)
			.limit(1);

		const memberId = existingMember?.id ?? nanoId();
		let inviteId: string | null = null;
		let inviteCreated = false;

		if (!existingMember) {
			const [existingInvite] = await tx
				.select({ id: organizationInvites.id })
				.from(organizationInvites)
				.where(
					and(
						eq(organizationInvites.organizationId, organizationId),
						eq(organizationInvites.invitedEmail, normalizedEmail),
					),
				)
				.limit(1);

			inviteId = existingInvite?.id ?? nanoId();

			if (!existingInvite) {
				await tx.insert(organizationInvites).values({
					id: inviteId,
					organizationId,
					invitedEmail: normalizedEmail,
					invitedByUserId,
					role,
				});
				inviteCreated = true;
			}
		}

		if (!existingMember) {
			await tx.insert(organizationMembers).values({
				id: memberId,
				organizationId,
				userId,
				role,
			});
		}

		let hasProSeat = existingMember?.hasProSeat ?? false;

		if (!hasProSeat && !existingMember) {
			const [organization] = await tx
				.select({ ownerId: organizations.ownerId })
				.from(organizations)
				.where(eq(organizations.id, organizationId))
				.limit(1);

			if (organization) {
				const [owner] = await tx
					.select({
						id: users.id,
						inviteQuota: users.inviteQuota,
						stripeSubscriptionId: users.stripeSubscriptionId,
						stripeSubscriptionStatus: users.stripeSubscriptionStatus,
					})
					.from(users)
					.where(eq(users.id, organization.ownerId))
					.limit(1);

				if (owner?.stripeSubscriptionId && hasActiveDirectSubscription(owner)) {
					const allMembers = await tx
						.select({
							id: organizationMembers.id,
							hasProSeat: organizationMembers.hasProSeat,
						})
						.from(organizationMembers)
						.where(eq(organizationMembers.organizationId, organizationId));

					const { proSeatsRemaining } = calculateProSeats({
						inviteQuota: owner.inviteQuota ?? 1,
						ownerId: organization.ownerId,
						ownerIsPro: true,
						members: allMembers,
					});

					if (proSeatsRemaining > 0) {
						await tx
							.update(organizationMembers)
							.set({ hasProSeat: true })
							.where(eq(organizationMembers.id, memberId));

						await tx
							.update(users)
							.set({
								thirdPartyStripeSubscriptionId: owner.stripeSubscriptionId,
							})
							.where(eq(users.id, userId));

						hasProSeat = true;
					}
				}
			}
		}

		return {
			userId,
			memberId,
			inviteId,
			hasProSeat,
			userCreated: !existingUser,
			memberCreated: !existingMember,
			inviteCreated,
		};
	});
}
