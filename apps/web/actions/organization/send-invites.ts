"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { deliverOrganizationInvite } from "@/lib/organization-invite-delivery";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import {
	type AssignableOrganizationRole,
	normalizeAssignableOrganizationRole,
} from "@/lib/permissions/roles";
import { requireOrganizationSettingsManager } from "./authorization";

type OrganizationInviteInput = {
	email: string;
	role?: string | null;
};

export async function sendOrganizationInvites(
	inviteInputs: string[] | OrganizationInviteInput[],
	organizationId: Organisation.OrganisationId,
	roleInput = "member",
	options: { sendEmailNotifications?: boolean } = {},
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const role = normalizeAssignableOrganizationRole(roleInput);
	if (!role) {
		throw new Error("Invalid organization role");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization) {
		throw new Error("Organization not found");
	}

	await requireOrganizationSettingsManager(user.id, organizationId);

	const MAX_INVITES = 50;
	if (inviteInputs.length > MAX_INVITES) {
		throw new Error(`Cannot send more than ${MAX_INVITES} invites at once`);
	}

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const inviteMap = new Map<string, AssignableOrganizationRole>();

	for (const inviteInput of inviteInputs) {
		const email =
			typeof inviteInput === "string" ? inviteInput : inviteInput.email;
		const normalizedEmail = email.trim().toLowerCase();
		if (!emailRegex.test(normalizedEmail)) continue;

		const inviteRole =
			typeof inviteInput === "string" || !inviteInput.role
				? role
				: normalizeAssignableOrganizationRole(inviteInput.role);

		if (!inviteRole) {
			throw new Error("Invalid organization role");
		}

		inviteMap.set(normalizedEmail, inviteRole);
	}

	const validInvites = Array.from(inviteMap, ([email, inviteRole]) => ({
		email,
		role: inviteRole,
	}));
	const validEmails = validInvites.map((invite) => invite.email);

	if (validEmails.length === 0) {
		return { success: true, failedEmails: [] as string[] };
	}

	if (options.sendEmailNotifications === false) {
		const provisionResults = await Promise.allSettled(
			validInvites.map((invite) =>
				provisionOrganizationInvitee({
					organizationId,
					email: invite.email,
					invitedByUserId: user.id,
					role: invite.role,
				}),
			),
		);
		const failedEmails = validInvites
			.filter((_, index) => provisionResults[index]?.status === "rejected")
			.map((invite) => invite.email);

		revalidatePath("/dashboard/settings/organization");

		return { success: true, failedEmails };
	}

	const inviteRecords = await db().transaction(async (tx) => {
		const [existingInvites, existingMembers] = await Promise.all([
			tx
				.select({ invitedEmail: organizationInvites.invitedEmail })
				.from(organizationInvites)
				.where(
					and(
						eq(organizationInvites.organizationId, organizationId),
						or(
							inArray(organizationInvites.invitedEmailNormalized, validEmails),
							inArray(organizationInvites.invitedEmail, validEmails),
						),
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

		const invitesToSend = validInvites.filter(
			(invite) =>
				!existingInviteEmails.has(invite.email) &&
				!existingMemberEmails.has(invite.email),
		);

		const createdAt = new Date();
		const records = invitesToSend.map((invite) => ({
			id: nanoId(),
			email: invite.email,
			role: invite.role,
			createdAt,
		}));

		if (records.length > 0) {
			await tx
				.insert(organizationInvites)
				.values(
					records.map((r) => ({
						id: r.id,
						organizationId: organizationId,
						invitedEmail: r.email,
						invitedEmailNormalized: r.email,
						invitedByUserId: user.id,
						role: r.role,
						emailDeliveryState: "pending" as const,
						emailDeliveryNextAttemptAt: r.createdAt,
						createdAt: r.createdAt,
					})),
				)
				.onDuplicateKeyUpdate({
					set: {
						invitedEmailNormalized: sql`${organizationInvites.invitedEmailNormalized}`,
					},
				});
		}

		return records;
	});

	const emailResults = await Promise.allSettled(
		inviteRecords.map((record) => deliverOrganizationInvite(record.id)),
	);

	const failedInvites = inviteRecords.filter((_, i) => {
		const result = emailResults[i];
		return (
			result?.status === "rejected" ||
			(result?.status === "fulfilled" && result.value.status === "deferred")
		);
	});
	const failedEmails = failedInvites.map((r) => r.email);

	revalidatePath("/dashboard/settings/organization");

	return { success: true, failedEmails };
}
