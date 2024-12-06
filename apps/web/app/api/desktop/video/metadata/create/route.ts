import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId");
    const xStreamInfo = url.searchParams.get("xStreamInfo");

    if (!videoId || !xStreamInfo) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    await db
      .update(videos)
      .set({ xStreamInfo: xStreamInfo })
      .where(eq(videos.id, videoId));

    return Response.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error updating xStreamInfo", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
