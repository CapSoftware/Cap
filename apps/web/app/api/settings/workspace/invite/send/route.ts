import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, spaceInvites } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { sendEmail } from "@cap/database/emails/config";
import { WorkspaceInvite } from "@cap/database/emails/workspace-invite";
import { clientEnv } from "@cap/env";

export async function POST(request: NextRequest) {
  console.log("POST request received for workspace invite");
  const user = await getCurrentUser();
  const { invitedEmails, spaceId } = await request.json();
  console.log(`Received invitedEmails: ${invitedEmails}, spaceId: ${spaceId}`);

  if (!user) {
    console.error("User not found");
    return Response.json({ error: true }, { status: 401 });
  }

  console.log(`User found: ${user.id}`);

  const space = await db.select().from(spaces).where(eq(spaces.id, spaceId));
  console.log(`Space query result:`, space);

  if (!space || space.length === 0) {
    console.error(`Space not found for spaceId: ${spaceId}`);
    return Response.json({ error: true }, { status: 404 });
  }

  if (space[0]?.ownerId !== user.id) {
    console.error(`User ${user.id} is not the owner of space ${spaceId}`);
    return Response.json({ error: true }, { status: 403 });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validEmails = invitedEmails.filter((email: string) =>
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

  console.log("Workspace invites created and emails sent successfully");
  return Response.json(true, { status: 200 });
}
