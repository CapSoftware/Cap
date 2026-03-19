import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { calculateProSeats } from "@/utils/organization";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let inviteId: unknown;
	try {
		({ inviteId } = await request.json());
	} catch {
		return NextResponse.json(
			{ error: "Invalid request body" },
			{ status: 400 },
		);
	}

	if (typeof inviteId !== "string" || !inviteId) {
		return NextResponse.json({ error: "Invalid invite ID" }, { status: 400 });
	}

	try {
		await db().transaction(async (tx) => {
			const [invite] = await tx
				.select()
				.from(organizationInvites)
				.where(eq(organizationInvites.id, inviteId))
				.for("update");

			if (!invite) {
				throw new Error("INVITE_NOT_FOUND");
			}

			if (user.email.toLowerCase() !== invite.invitedEmail.toLowerCase()) {
				throw new Error("EMAIL_MISMATCH");
			}

			const [existingMembership] = await tx
				.select({ id: organizationMembers.id })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, invite.organizationId),
						eq(organizationMembers.userId, user.id),
					),
				)
				.limit(1);

			let memberId = existingMembership?.id;

			if (!existingMembership) {
				const newId = nanoId();
				await tx.insert(organizationMembers).values({
					id: newId,
					organizationId: invite.organizationId,
					userId: user.id,
					role: invite.role,
				});
				memberId = newId;
			}

			const [org] = await tx
				.select({ ownerId: organizations.ownerId })
				.from(organizations)
				.where(eq(organizations.id, invite.organizationId))
				.limit(1);

			if (org && memberId && !existingMembership) {
				const [owner] = await tx
					.select({
						inviteQuota: users.inviteQuota,
						stripeSubscriptionId: users.stripeSubscriptionId,
					})
					.from(users)
					.where(eq(users.id, org.ownerId))
					.limit(1);

				if (owner?.stripeSubscriptionId) {
					const allMembers = await tx
						.select({
							id: organizationMembers.id,
							hasProSeat: organizationMembers.hasProSeat,
						})
						.from(organizationMembers)
						.where(
							eq(organizationMembers.organizationId, invite.organizationId),
						)
						.for("update");

					const { proSeatsRemaining } = calculateProSeats({
						inviteQuota: owner.inviteQuota ?? 1,
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
							.where(eq(users.id, user.id));
					}
				}
			}

			const onboardingSteps = {
				...(user.onboardingSteps ?? {}),
				organizationSetup: true,
				customDomain: true,
				inviteTeam: true,
			};

			const userUpdate: Partial<typeof users.$inferInsert> = {
				onboardingSteps,
				activeOrganizationId: invite.organizationId,
			};
			if (!user.defaultOrgId) {
				userUpdate.defaultOrgId = invite.organizationId;
			}

			await tx.update(users).set(userUpdate).where(eq(users.id, user.id));

			await tx
				.delete(organizationInvites)
				.where(eq(organizationInvites.id, inviteId));
		});

		return NextResponse.json({ success: true });
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === "INVITE_NOT_FOUND") {
				return NextResponse.json(
					{ error: "Invite not found" },
					{ status: 404 },
				);
			}
			if (error.message === "EMAIL_MISMATCH") {
				return NextResponse.json({ error: "Email mismatch" }, { status: 403 });
			}
		}
		console.error("Error accepting invite:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
