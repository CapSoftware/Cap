import { NextRequest, NextResponse } from "next/server";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, videos } from "@cap/database/schema";
import { eq, and } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { capId, spaceIds } = await request.json();

  try {
    // Check if the user owns the cap
    const [cap] = await db.select().from(videos).where(eq(videos.id, capId));
    if (!cap || cap.ownerId !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Get current shared spaces
    const currentSharedSpaces = await db
      .select()
      .from(sharedVideos)
      .where(eq(sharedVideos.videoId, capId));

    // Remove spaces that are no longer shared
    for (const sharedSpace of currentSharedSpaces) {
      if (!spaceIds.includes(sharedSpace.spaceId)) {
        await db
          .delete(sharedVideos)
          .where(
            and(
              eq(sharedVideos.videoId, capId),
              eq(sharedVideos.spaceId, sharedSpace.spaceId)
            )
          );
      }
    }

    // Add new shared spaces
    for (const spaceId of spaceIds) {
      const existingShare = currentSharedSpaces.find(
        (share) => share.spaceId === spaceId
      );
      if (!existingShare) {
        await db.insert(sharedVideos).values({
          id: nanoId(),
          videoId: capId,
          spaceId: spaceId,
          sharedByUserId: user.id,
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating shared spaces:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
