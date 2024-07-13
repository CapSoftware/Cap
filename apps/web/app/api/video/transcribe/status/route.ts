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
    return new Response(JSON.stringify({ auth: false }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (!videoId) {
    return new Response(
      JSON.stringify({ error: true, message: "videoId not supplied" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  const video = await db.select().from(videos).where(eq(videos.id, videoId));

  if (video.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  return new Response(
    JSON.stringify({
      transcriptionStatus: video[0].transcriptionStatus,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
