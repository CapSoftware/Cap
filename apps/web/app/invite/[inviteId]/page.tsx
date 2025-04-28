import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { spaceInvites, spaces, users } from "@cap/database/schema";
import { getCurrentUser, userSelectProps } from "@cap/database/auth/session";
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
    title: `Join ${invite.spaceName} on Cap`,
    description: `You've been invited to join ${invite.spaceName} on Cap.`,
  };
}

async function getInviteDetails(inviteId: string) {
  const query = await db
    .select({
      invite: spaceInvites,
      spaceName: spaces.name,
      inviterName: users.name,
    })
    .from(spaceInvites)
    .leftJoin(spaces, eq(spaceInvites.spaceId, spaces.id))
    .leftJoin(users, eq(spaceInvites.invitedByUserId, users.id))
    .where(eq(spaceInvites.id, inviteId));

  return query[0];
}

export default async function InvitePage({ params }: Props) {
  const inviteId = params.inviteId;
  const user = await getCurrentUser();
  const inviteDetails = await getInviteDetails(inviteId);

  if (!inviteDetails) {
    return notFound();
  }

  if (!inviteDetails.spaceName || !inviteDetails.inviterName) {
    return notFound();
  }

  return (
    <InviteAccept
      inviteId={inviteId}
      teamName={inviteDetails.spaceName}
      inviterName={inviteDetails.inviterName}
      user={user as typeof userSelectProps | null}
    />
  );
}
