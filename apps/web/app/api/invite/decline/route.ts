import { NextRequest, NextResponse } from "next/server";
import { db } from "@cap/database";
import { spaceInvites } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const { inviteId } = await request.json();

  try {
    // Delete the invite
    await db.delete(spaceInvites).where(eq(spaceInvites.id, inviteId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error declining invite:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}