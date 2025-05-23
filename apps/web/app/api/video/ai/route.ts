import { NextRequest } from "next/server";
import { after } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const videoId = url.searchParams.get("videoId");

  if (!user) {
    return Response.json({ auth: false }, { status: 401 });
  }

  if (!videoId) {
    return Response.json({ error: true }, { status: 400 });
  }

  const result = await db().select().from(videos).where(eq(videos.id, videoId));
  if (result.length === 0 || !result[0]) {
    return Response.json({ error: true }, { status: 404 });
  }

  const video = result[0];
  const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

  if (!metadata.summary && video.transcriptionStatus === "COMPLETE") {
    after(() => generateAiMetadata(videoId, video.ownerId));
    return Response.json({ processing: true }, { status: 200 });
  }

  return Response.json(
    {
      processing: !metadata.summary,
      title: metadata.aiTitle ?? null,
      summary: metadata.summary ?? null,
      chapters: metadata.chapters ?? null,
    },
    { status: 200 }
  );
}
