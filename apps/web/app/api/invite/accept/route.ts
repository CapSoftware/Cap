import { NextRequest, NextResponse } from "next/server";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaceInvites, spaceMembers } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers"

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { inviteId } = await request.json();

  try {
    // Find the invite
    const [invite] = await db
      .select()
      .from(spaceInvites)
      .where(eq(spaceInvites.id, inviteId));

    if (!invite) {
      return NextResponse.json({ error: "Invite not found" }, { status: 404 });
    }

    // Check if the user's email matches the invited email
    if (user.email !== invite.invitedEmail) {
      return NextResponse.json({ error: "Email mismatch" }, { status: 403 });
    }

    // Create a new space member
    await db.insert(spaceMembers).values({
      id: nanoId(),
      spaceId: invite.spaceId,
      userId: user.id,
      role: invite.role,
    });

    // Delete the invite
    await db.delete(spaceInvites).where(eq(spaceInvites.id, inviteId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error accepting invite:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}