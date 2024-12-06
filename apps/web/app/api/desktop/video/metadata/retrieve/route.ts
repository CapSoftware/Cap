import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId");

    if (!videoId) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const query = await db.select().from(videos).where(eq(videos.id, videoId));

    if (query.length === 0) {
      return Response.json({ error: "Video not found" }, { status: 404 });
    }

    const video = query[0]!;
    const videoStartTime = video.videoStartTime
      ? new Date(video.videoStartTime).getTime()
      : 0;
    const audioStartTime = video.audioStartTime
      ? new Date(video.audioStartTime).getTime()
      : 0;

    const timeDifference = videoStartTime - audioStartTime;

    return Response.json(
      { success: true, difference: timeDifference },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error updating video or audio start time", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
