'use server';

import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, spaceInvites } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { sendEmail } from "@cap/database/emails/config";
import { WorkspaceInvite } from "@cap/database/emails/workspace-invite";
import { clientEnv } from "@cap/env";
import { revalidatePath } from "next/cache";

export async function sendWorkspaceInvites(
  invitedEmails: string[],
  spaceId: string
) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const space = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space || space.length === 0) {
    throw new Error("Workspace not found");
  }

  if (space[0]?.ownerId !== user.id) {
    throw new Error("Only the owner can send workspace invites");
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validEmails = invitedEmails.filter((email) =>
    emailRegex.test(email.trim())
  );

  for (const email of validEmails) {
    const inviteId = nanoId();
    await db.insert(spaceInvites).values({
      id: inviteId,
      spaceId: spaceId,
      invitedEmail: email.trim(),
      invitedByUserId: user.id,
      role: "member",
    });

    // Send invitation email
    const inviteUrl = `${clientEnv.NEXT_PUBLIC_WEB_URL}/invite/${inviteId}`;
    await sendEmail({
      email: email.trim(),
      subject: `Invitation to join ${space[0].name} on Cap`,
      react: WorkspaceInvite({
        email: email.trim(),
        url: inviteUrl,
        workspaceName: space[0].name,
      }),
    });
  }

  revalidatePath('/dashboard/settings/workspace');
  
  return { success: true };
} 