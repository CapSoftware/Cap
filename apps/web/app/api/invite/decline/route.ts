import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationInvites,
	organizationMembers,
	spaceMembers,
	spaces,
	users,
} from "@cap/database/schema";
import { Organisation } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

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

			const [membership] = await tx
				.select({
					id: organizationMembers.id,
					hasProSeat: organizationMembers.hasProSeat,
				})
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, invite.organizationId),
						eq(organizationMembers.userId, user.id),
					),
				)
				.limit(1);

			if (membership) {
				const organizationSpaces = await tx
					.select({ id: spaces.id })
					.from(spaces)
					.where(eq(spaces.organizationId, invite.organizationId));
				const spaceIds = organizationSpaces.map((space) => space.id);

				if (spaceIds.length > 0) {
					await tx
						.delete(spaceMembers)
						.where(
							and(
								eq(spaceMembers.userId, user.id),
								inArray(spaceMembers.spaceId, spaceIds),
							),
						);
				}

				await tx
					.delete(organizationMembers)
					.where(eq(organizationMembers.id, membership.id));

				const [remainingMembership] = await tx
					.select({ organizationId: organizationMembers.organizationId })
					.from(organizationMembers)
					.where(eq(organizationMembers.userId, user.id))
					.limit(1);

				const userUpdate: Partial<typeof users.$inferInsert> = {};
				if (user.activeOrganizationId === invite.organizationId) {
					userUpdate.activeOrganizationId =
						remainingMembership?.organizationId ??
						Organisation.OrganisationId.make("");
				}
				if (user.defaultOrgId === invite.organizationId) {
					userUpdate.defaultOrgId = remainingMembership?.organizationId ?? null;
				}
				if (membership.hasProSeat) {
					const [otherProSeat] = await tx
						.select({ id: organizationMembers.id })
						.from(organizationMembers)
						.where(
							and(
								eq(organizationMembers.userId, user.id),
								eq(organizationMembers.hasProSeat, true),
							),
						)
						.limit(1);

					if (!otherProSeat) {
						userUpdate.thirdPartyStripeSubscriptionId = null;
					}
				}

				if (Object.keys(userUpdate).length > 0) {
					await tx.update(users).set(userUpdate).where(eq(users.id, user.id));
				}
			}

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
		console.error("Error declining invite:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
