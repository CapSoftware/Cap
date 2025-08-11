import { NextRequest } from "next/server";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get("videoId");

  if (!videoId) {
    return Response.json({ error: "Video ID is required" }, { status: 400 });
  }

  try {
    const result = await getVideoAnalytics(videoId);
    return Response.json({ count: result.count }, { status: 200 });
  } catch (error) {
    console.error("Error fetching video analytics:", error);
    return Response.json(
      { error: "Failed to fetch analytics" },
      { status: 500 }
    );
  }
}
