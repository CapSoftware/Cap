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

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { inviteId } = await request.json();

	try {
		const [invite] = await db()
			.select()
			.from(organizationInvites)
			.where(eq(organizationInvites.id, inviteId));

		if (!invite) {
			return NextResponse.json({ error: "Invite not found" }, { status: 404 });
		}

		if (user.email !== invite.invitedEmail) {
			return NextResponse.json({ error: "Email mismatch" }, { status: 403 });
		}

		const [org] = await db()
			.select({
				stripeSubscriptionId: organizations.stripeSubscriptionId,
			})
			.from(organizations)
			.where(eq(organizations.id, invite.organizationId));

		const [existingMembership] = await db()
			.select({ id: organizationMembers.id })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, invite.organizationId),
					eq(organizationMembers.userId, user.id),
				),
			)
			.limit(1);

		if (!existingMembership) {
			await db().insert(organizationMembers).values({
				id: nanoId(),
				organizationId: invite.organizationId,
				userId: user.id,
				role: invite.role,
				seatType: "free",
			});
		}

		const onboardingSteps = {
			...(user.onboardingSteps ?? {}),
			organizationSetup: true,
			customDomain: true,
			inviteTeam: true,
		};

		await db()
			.update(users)
			.set({
				thirdPartyStripeSubscriptionId: org?.stripeSubscriptionId || null,
				activeOrganizationId: invite.organizationId,
				defaultOrgId: invite.organizationId,
				onboardingSteps,
			})
			.where(eq(users.id, user.id));

		await db()
			.delete(organizationInvites)
			.where(eq(organizationInvites.id, inviteId));

		return NextResponse.json({ success: true });
	} catch (error) {
		console.error("Error accepting invite:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
