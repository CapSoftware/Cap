import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { rateLimitMiddleware } from "@/utils/helpers";

export async function handlePut(request: NextRequest) {
  const user = await getCurrentUser();
  const { title, videoId } = await request.json();
  const userId = user?.id as string;

  if (!user || !title || !videoId) {
    console.error("Missing required data in /api/video/title/route.ts");

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

  await db
    .update(videos)
    .set({
      name: title,
    })
    .where(eq(videos.id, videoId));

  return Response.json(true, { status: 200 });
}

export const PUT = (request: NextRequest) => {
  const headersList = headers();
  return rateLimitMiddleware(10, handlePut(request), headersList);
};
