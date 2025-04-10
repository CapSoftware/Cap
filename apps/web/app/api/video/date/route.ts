import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { rateLimitMiddleware } from "@/utils/helpers";
import { VideoMetadata } from "@cap/database/types";

export async function handlePut(request: NextRequest) {
  const user = await getCurrentUser();
  const { date, videoId } = await request.json();
  const userId = user?.id as string;

  if (!user || !date || !videoId) {
    console.error("Missing required data in /api/video/date/route.ts");
    return Response.json({ error: true }, { status: 401 });
  }

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return Response.json({ error: true }, { status: 401 });
  }

  const video = query[0];
  if (!video) {
    return Response.json({ error: true }, { status: 401 });
  }

  if (video.ownerId !== userId) {
    return Response.json({ error: true }, { status: 401 });
  }

  try {
    const newDate = new Date(date);
    const currentDate = new Date();
    
    // Prevent future dates
    if (newDate > currentDate) {
      return Response.json(
        { error: "Cannot set a date in the future" }, 
        { status: 400 }
      );
    }
    
    // Store the custom date in the metadata field
    const currentMetadata = video.metadata as VideoMetadata || {};
    const updatedMetadata: VideoMetadata = {
      ...currentMetadata,
      customCreatedAt: newDate.toISOString(),
    };
    
    await db
      .update(videos)
      .set({
        metadata: updatedMetadata,
      })
      .where(eq(videos.id, videoId));

    return Response.json(true, { status: 200 });
  } catch (error) {
    console.error("Error updating video date:", error);
    return Response.json({ error: true }, { status: 500 });
  }
}

export const PUT = (request: NextRequest) => {
  const headersList = headers();
  return rateLimitMiddleware(10, handlePut(request), headersList);
}; 