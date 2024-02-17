import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId");
    const startTime = url.searchParams.get("startTime");
    const logType = url.searchParams.get("logType");

    if (!videoId || (!startTime && !logType)) {
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

    if (logType === "video") {
      console.log("...Updating video start time...");
      await db
        .update(videos)
        .set({ videoStartTime: Number(startTime) })
        .where(eq(videos.id, videoId));
    }

    if (logType === "audio") {
      console.log("...Updating audio start time...");
      await db
        .update(videos)
        .set({ audioStartTime: Number(startTime) })
        .where(eq(videos.id, videoId));
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
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
