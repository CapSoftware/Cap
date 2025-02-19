import { NextRequest, NextResponse } from "next/server";
import { db } from "@cap/database";
import { spaceInvites } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { updateCloudWorkspaceUserCount } from "@/utils/instance/functions";

export async function POST(request: NextRequest) {
  const { inviteId } = await request.json();

  try {
    const inviteData = await db.query.spaceInvites.findFirst({
      where: eq(spaceInvites.id, inviteId),
      columns: {
        spaceId: true,
      },
    });

    if (!inviteData) {
      return NextResponse.json({ error: "Invite not found" }, { status: 404 });
    }

    // Delete the invite
    await db.delete(spaceInvites).where(eq(spaceInvites.id, inviteId));

    // Update workspace user count
    await updateCloudWorkspaceUserCount({
      workspaceId: inviteData.spaceId,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error declining invite:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
