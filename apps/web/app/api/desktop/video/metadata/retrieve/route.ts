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
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    const query = await db.select().from(videos).where(eq(videos.id, videoId));

    if (query.length === 0) {
      return new Response(JSON.stringify({ error: "Video not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const video = query[0];
    const videoStartTime = video.videoStartTime
      ? new Date(video.videoStartTime).getTime()
      : 0;
    const audioStartTime = video.audioStartTime
      ? new Date(video.audioStartTime).getTime()
      : 0;

    const timeDifference = videoStartTime - audioStartTime;

    return new Response(
      JSON.stringify({ success: true, difference: timeDifference }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error updating video or audio start time", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
