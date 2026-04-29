"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { calculateProSeats } from "@/utils/organization";

export async function toggleProSeat(
	memberId: string,
	organizationId: Organisation.OrganisationId,
	enable: boolean,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization) {
		throw new Error("Organization not found");
	}

	if (organization.ownerId !== user.id) {
		throw new Error("Only the owner can manage Pro seats");
	}

	await db().transaction(async (tx) => {
		const [member] = await tx
			.select()
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.id, memberId),
					eq(organizationMembers.organizationId, organizationId),
				),
			)
			.for("update");

		if (!member) {
			throw new Error("Member not found");
		}

		if (member.userId === organization.ownerId) {
			throw new Error("Cannot toggle Pro seat for the organization owner");
		}

		if (member.hasProSeat === enable) {
			return { success: true };
		}

		if (enable) {
			const allMembers = await tx
				.select({
					id: organizationMembers.id,
					hasProSeat: organizationMembers.hasProSeat,
				})
				.from(organizationMembers)
				.where(eq(organizationMembers.organizationId, organizationId))
				.for("update");

			const [owner] = await tx
				.select({
					inviteQuota: users.inviteQuota,
					stripeSubscriptionId: users.stripeSubscriptionId,
				})
				.from(users)
				.where(eq(users.id, organization.ownerId))
				.limit(1);

			const { proSeatsRemaining } = calculateProSeats({
				inviteQuota: owner?.inviteQuota ?? 1,
				members: allMembers,
			});

			if (proSeatsRemaining <= 0) {
				throw new Error(
					"No Pro seats remaining. Purchase more seats to continue.",
				);
			}

			await tx
				.update(organizationMembers)
				.set({ hasProSeat: true })
				.where(eq(organizationMembers.id, memberId));

			if (owner?.stripeSubscriptionId) {
				await tx
					.update(users)
					.set({ thirdPartyStripeSubscriptionId: owner.stripeSubscriptionId })
					.where(eq(users.id, member.userId));
			}
		} else {
			await tx
				.update(organizationMembers)
				.set({ hasProSeat: false })
				.where(eq(organizationMembers.id, memberId));

			const otherProSeats = await tx
				.select({ id: organizationMembers.id })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.userId, member.userId),
						eq(organizationMembers.hasProSeat, true),
					),
				)
				.limit(1);

			if (otherProSeats.length === 0) {
				await tx
					.update(users)
					.set({ thirdPartyStripeSubscriptionId: null })
					.where(eq(users.id, member.userId));
			} else {
				const [remainingOrg] = await tx
					.select({ stripeSubscriptionId: users.stripeSubscriptionId })
					.from(organizationMembers)
					.innerJoin(
						organizations,
						eq(organizationMembers.organizationId, organizations.id),
					)
					.innerJoin(users, eq(organizations.ownerId, users.id))
					.where(
						and(
							eq(organizationMembers.userId, member.userId),
							eq(organizationMembers.hasProSeat, true),
						),
					)
					.limit(1);

				if (remainingOrg?.stripeSubscriptionId) {
					await tx
						.update(users)
						.set({
							thirdPartyStripeSubscriptionId: remainingOrg.stripeSubscriptionId,
						})
						.where(eq(users.id, member.userId));
				} else {
					await tx
						.update(users)
						.set({ thirdPartyStripeSubscriptionId: null })
						.where(eq(users.id, member.userId));
				}
			}
		}
	});

	revalidatePath("/dashboard/settings/organization");
	return { success: true };
}
