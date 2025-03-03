import { db } from "@cap/database";
import { videos, sharedVideos, spaces } from "@cap/database/schema";
import { eq, and } from "drizzle-orm";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const videoId = searchParams.get("videoId");

  if (!videoId) {
    return Response.json({ error: "Video ID is required" }, { status: 400 });
  }

  try {
    // First, get the video to find the owner or shared space
    const video = await db
      .select({
        id: videos.id,
        ownerId: videos.ownerId,
      })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);

    if (video.length === 0) {
      return Response.json({ error: "Video not found" }, { status: 404 });
    }

    const videoData = video[0];
    if (!videoData || !videoData.ownerId) {
      return Response.json({ error: "Invalid video data" }, { status: 500 });
    }

    // Check if the video is shared with a space
    const sharedVideo = await db
      .select({
        spaceId: sharedVideos.spaceId,
      })
      .from(sharedVideos)
      .where(eq(sharedVideos.videoId, videoId))
      .limit(1);

    let spaceId = null;
    if (sharedVideo.length > 0 && sharedVideo[0] && sharedVideo[0].spaceId) {
      spaceId = sharedVideo[0].spaceId;
    }

    // If we have a space ID, get the space's custom domain
    if (spaceId) {
      const space = await db
        .select({
          customDomain: spaces.customDomain,
          domainVerified: spaces.domainVerified,
        })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1);

      if (space.length > 0 && space[0] && space[0].customDomain) {
        return Response.json({
          customDomain: space[0].customDomain,
          domainVerified: space[0].domainVerified || false,
        });
      }
    }

    // If no shared space or no custom domain, check the owner's space
    const ownerSpaces = await db
      .select({
        customDomain: spaces.customDomain,
        domainVerified: spaces.domainVerified,
      })
      .from(spaces)
      .where(eq(spaces.ownerId, videoData.ownerId))
      .limit(1);

    if (ownerSpaces.length > 0 && ownerSpaces[0] && ownerSpaces[0].customDomain) {
      return Response.json({
        customDomain: ownerSpaces[0].customDomain,
        domainVerified: ownerSpaces[0].domainVerified || false,
      });
    }

    // No custom domain found
    return Response.json({
      customDomain: null,
      domainVerified: false,
    });
  } catch (error) {
    console.error("Error fetching domain info:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
} 