import { isUserOnProPlan } from "@cap/utils";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest } from "next/server";
import { count, eq } from "drizzle-orm";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const videoId = url.searchParams.get("videoId");

  if (!user) {
    return Response.json({ auth: false }, { status: 401 });
  }

  if (!videoId) {
    return Response.json(
      { error: true, message: "videoId not supplied" },
      { status: 400 }
    );
  }

  const video = await db.select().from(videos).where(eq(videos.id, videoId));

  if (video.length === 0 || !video[0]) {
    return Response.json(
      { error: true, message: "Video does not exist" },
      { status: 404 }
    );
  }

  return Response.json(
    { transcriptionStatus: video[0].transcriptionStatus },
    { status: 200 }
  );
}
