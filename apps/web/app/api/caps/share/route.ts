import { NextRequest, NextResponse } from "next/server";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, videos, spaces } from "@cap/database/schema";
import { eq, and, inArray } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { capId, spaceIds } = await request.json();

  try {
    const [cap] = await db().select().from(videos).where(eq(videos.id, capId));
    if (!cap || cap.ownerId !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Get spaces data to find their organizationIds
    const spacesData = await db()
      .select()
      .from(spaces)
      .where(inArray(spaces.id, spaceIds));

    // Extract organization IDs from spaces
    const organizationIds = [...new Set(spacesData.map(space => space.organizationId))];

    const currentSharedOrganizations = await db()
      .select()
      .from(sharedVideos)
      .where(eq(sharedVideos.videoId, capId));

    // Remove sharing from organizations not in the list
    for (const sharedOrganization of currentSharedOrganizations) {
      if (!organizationIds.includes(sharedOrganization.organizationId)) {
        await db()
          .delete(sharedVideos)
          .where(
            and(
              eq(sharedVideos.videoId, capId),
              eq(sharedVideos.organizationId, sharedOrganization.organizationId)
            )
          );
      }
    }

    // Add sharing for new organizations
    for (const organizationId of organizationIds) {
      const existingShare = currentSharedOrganizations.find(
        (share) => share.organizationId === organizationId
      );
      if (!existingShare) {
        await db().insert(sharedVideos).values({
          id: nanoId(),
          videoId: capId,
          organizationId: organizationId,
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
