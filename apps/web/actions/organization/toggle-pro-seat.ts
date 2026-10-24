"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	calculateProSeats,
	hasActiveDirectSubscription,
	selectProSeatProvider,
} from "@/utils/organization";
import { requireOrganizationProSeatManager } from "./authorization";

export async function toggleProSeat(
	memberId: string,
	organizationId: Organisation.OrganisationId,
	enable: boolean,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const actor = await requireOrganizationProSeatManager(
		user.id,
		organizationId,
	);

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

		if (member.userId === actor.ownerId) {
			throw new Error("Cannot toggle Pro seat for the organization owner");
		}

		if (member.hasProSeat === enable && !enable) {
			return { success: true };
		}

		if (enable) {
			const allMembers = await tx
				.select({
					id: organizationMembers.id,
					userId: organizationMembers.userId,
					hasProSeat: organizationMembers.hasProSeat,
				})
				.from(organizationMembers)
				.where(eq(organizationMembers.organizationId, organizationId))
				.for("update");

			const managerIds = Array.from(new Set([actor.ownerId, user.id]));
			const managers = await tx
				.select({
					id: users.id,
					inviteQuota: users.inviteQuota,
					stripeSubscriptionId: users.stripeSubscriptionId,
					stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				})
				.from(users)
				.where(inArray(users.id, managerIds));
			const owner = managers.find((manager) => manager.id === actor.ownerId);
			const currentManager = managers.find((manager) => manager.id === user.id);
			const seatProvider = selectProSeatProvider({
				actor: currentManager,
				owner,
				actorCanManageProSeats: true,
			});
			if (!seatProvider) {
				throw new Error(
					"An active Cap Pro subscription is required before assigning seats.",
				);
			}

			if (!member.hasProSeat) {
				const { proSeatsRemaining } = calculateProSeats({
					inviteQuota: seatProvider.inviteQuota ?? 1,
					ownerId: actor.ownerId,
					ownerIsPro: hasActiveDirectSubscription(owner),
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
			}

			if (seatProvider.stripeSubscriptionId) {
				await tx
					.update(users)
					.set({
						thirdPartyStripeSubscriptionId: seatProvider.stripeSubscriptionId,
					})
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
