"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sendEmail } from "@cap/database/emails/config";
import { OrganizationInvite } from "@cap/database/emails/organization-invite";
import { nanoId } from "@cap/database/helpers";
import { organizationInvites, organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function sendOrganizationInvites(
	invitedEmails: string[],
	organizationId: string,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const organization = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization || organization.length === 0) {
		throw new Error("Organization not found");
	}

	if (organization[0]?.ownerId !== user.id) {
		throw new Error("Only the owner can send organization invites");
	}

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const validEmails = invitedEmails.filter((email) =>
		emailRegex.test(email.trim()),
	);

	for (const email of validEmails) {
		const inviteId = nanoId();
		await db().insert(organizationInvites).values({
			id: inviteId,
			organizationId: organizationId,
			invitedEmail: email.trim(),
			invitedByUserId: user.id,
			role: "member",
		});

		// Send invitation email
		const inviteUrl = `${serverEnv().WEB_URL}/invite/${inviteId}`;
		await sendEmail({
			email: email.trim(),
			subject: `Invitation to join ${organization[0].name} on Cap`,
			react: OrganizationInvite({
				email: email.trim(),
				url: inviteUrl,
				organizationName: organization[0].name,
			}),
		});
	}

	revalidatePath("/dashboard/settings/organization");

	return { success: true };
}
