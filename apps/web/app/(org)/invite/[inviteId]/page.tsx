import "../../onboarding/onboarding.css";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationInvites,
	organizations,
	users,
} from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaperRoot } from "../../onboarding/components/PaperRoot";
import { maskEmail, needsOnboarding } from "../../onboarding/onboarding-flow";
import { InviteAccept } from "./InviteAccept";

type Props = {
	params: Promise<{ inviteId: string }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
	const params = await props.params;
	const inviteId = params.inviteId;
	const invite = await getInviteDetails(inviteId);

	if (!invite) {
		return notFound();
	}

	return {
		title: `Join ${invite.organizationName} on Cap`,
		description: `You've been invited to join ${invite.organizationName} on Cap.`,
	};
}

async function getInviteDetails(inviteId: string) {
	const query = await db()
		.select({
			invite: organizationInvites,
			organizationName: organizations.name,
			inviterName: users.name,
		})
		.from(organizationInvites)
		.leftJoin(
			organizations,
			eq(organizationInvites.organizationId, organizations.id),
		)
		.leftJoin(users, eq(organizationInvites.invitedByUserId, users.id))
		.where(eq(organizationInvites.id, inviteId));

	return query[0];
}

export default async function InvitePage(props: Props) {
	const params = await props.params;
	const inviteId = params.inviteId;
	const user = await getCurrentUser();
	const inviteDetails = await getInviteDetails(inviteId);

	if (!inviteDetails) {
		return notFound();
	}

	if (!inviteDetails.organizationName || !inviteDetails.inviterName) {
		return notFound();
	}

	const invitedEmail = inviteDetails.invite.invitedEmail;

	return (
		<PaperRoot>
			<InviteAccept
				inviteId={inviteId}
				organizationName={inviteDetails.organizationName}
				inviterName={inviteDetails.inviterName}
				maskedEmail={maskEmail(invitedEmail)}
				invitedInitial={invitedEmail.charAt(0).toUpperCase()}
				signedInEmail={user?.email ?? null}
				emailMatches={
					user ? user.email.toLowerCase() === invitedEmail.toLowerCase() : false
				}
				needsOnboarding={user ? needsOnboarding(user) : false}
			/>
		</PaperRoot>
	);
}
