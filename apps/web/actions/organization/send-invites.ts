"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sendEmail } from "@cap/database/emails/config";
import { OrganizationInvite } from "@cap/database/emails/organization-invite";
import { nanoId } from "@cap/database/helpers";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function sendOrganizationInvites(
	invitedEmails: string[],
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization) {
		throw new Error("Organization not found");
	}

	const [ownerMembership] = await db()
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.userId, user.id),
				eq(organizationMembers.role, "owner"),
			),
		)
		.limit(1);

	if (!ownerMembership) {
		throw new Error("Only the organization owner can send invites");
	}

	const MAX_INVITES = 50;
	if (invitedEmails.length > MAX_INVITES) {
		throw new Error(`Cannot send more than ${MAX_INVITES} invites at once`);
	}

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const validEmails = Array.from(
		new Set(
			invitedEmails
				.map((email) => email.trim().toLowerCase())
				.filter((email) => emailRegex.test(email)),
		),
	);

	if (validEmails.length === 0) {
		return { success: true, failedEmails: [] as string[] };
	}

	const inviteRecords = await db().transaction(async (tx) => {
		const [existingInvites, existingMembers] = await Promise.all([
			tx
				.select({ invitedEmail: organizationInvites.invitedEmail })
				.from(organizationInvites)
				.where(
					and(
						eq(organizationInvites.organizationId, organizationId),
						inArray(organizationInvites.invitedEmail, validEmails),
					),
				),
			tx
				.select({ email: users.email })
				.from(organizationMembers)
				.innerJoin(users, eq(organizationMembers.userId, users.id))
				.where(
					and(
						eq(organizationMembers.organizationId, organizationId),
						inArray(users.email, validEmails),
					),
				),
		]);

		const existingInviteEmails = new Set(
			existingInvites.map((i) => i.invitedEmail.toLowerCase()),
		);

		const existingMemberEmails = new Set(
			existingMembers.map((m) => m.email.toLowerCase()),
		);

		const emailsToInvite = validEmails.filter(
			(email) =>
				!existingInviteEmails.has(email) && !existingMemberEmails.has(email),
		);

		const records = emailsToInvite.map((email) => ({
			id: nanoId(),
			email,
		}));

		if (records.length > 0) {
			await tx.insert(organizationInvites).values(
				records.map((r) => ({
					id: r.id,
					organizationId: organizationId,
					invitedEmail: r.email,
					invitedByUserId: user.id,
					role: "member" as const,
				})),
			);
		}

		return records;
	});

	const emailResults = await Promise.allSettled(
		inviteRecords.map((record) => {
			const inviteUrl = `${serverEnv().WEB_URL}/invite/${record.id}`;
			return sendEmail({
				email: record.email,
				subject: `Invitation to join ${organization.name} on Cap`,
				react: OrganizationInvite({
					email: record.email,
					url: inviteUrl,
					organizationName: organization.name,
				}),
			});
		}),
	);

	const failedInvites = inviteRecords.filter(
		(_, i) => emailResults[i]?.status === "rejected",
	);
	const failedEmails = failedInvites.map((r) => r.email);

	if (failedInvites.length > 0) {
		try {
			await db()
				.delete(organizationInvites)
				.where(
					inArray(
						organizationInvites.id,
						failedInvites.map((r) => r.id),
					),
				);
		} catch (cleanupError) {
			console.error(
				"Failed to clean up invite records after email delivery failure:",
				{
					failedInviteIds: failedInvites.map((r) => r.id),
					failedEmails,
					error: cleanupError,
				},
			);
		}
	}

	revalidatePath("/dashboard/settings/organization");

	return { success: true, failedEmails };
}
