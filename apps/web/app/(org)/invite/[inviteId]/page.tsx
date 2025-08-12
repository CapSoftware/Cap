import { db } from "@cap/database";
import {
	getCurrentUser,
	type userSelectProps,
} from "@cap/database/auth/session";
import {
	organizationInvites,
	organizations,
	users,
} from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InviteAccept } from ".//InviteAccept";

type Props = {
	params: { inviteId: string };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
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

export default async function InvitePage({ params }: Props) {
	const inviteId = params.inviteId;
	const user = await getCurrentUser();
	const inviteDetails = await getInviteDetails(inviteId);

	if (!inviteDetails) {
		return notFound();
	}

	if (!inviteDetails.organizationName || !inviteDetails.inviterName) {
		return notFound();
	}

	return (
		<InviteAccept
			inviteId={inviteId}
			organizationName={inviteDetails.organizationName}
			inviterName={inviteDetails.inviterName}
			user={user as typeof userSelectProps | null}
		/>
	);
}
