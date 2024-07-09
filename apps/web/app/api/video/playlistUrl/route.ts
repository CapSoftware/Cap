import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { getHeaders } from "@/utils/helpers";

export const revalidate = 0;

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin") as string;

  return new Response(null, {
    status: 200,
    headers: getHeaders(origin),
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get("userId") || "";
  const videoId = searchParams.get("videoId") || "";
  const origin = request.headers.get("origin") as string;

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const video = query[0];

  if (video.jobStatus === "COMPLETE") {
    const playlistUrl = `https://v.cap.so/${video.ownerId}/${video.id}/output/video_recording_000_output.m3u8`;
    return new Response(
      JSON.stringify({ playlistOne: playlistUrl, playlistTwo: null }),
      {
        status: 200,
        headers: getHeaders(origin),
      }
    );
  }

  return new Response(
    JSON.stringify({
      playlistOne: `${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${video.ownerId}&videoId=${video.id}&videoType=video`,
      playlistTwo: `${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${video.ownerId}&videoId=${video.id}&videoType=audio`,
    }),
    {
      status: 200,
      headers: getHeaders(origin),
    }
  );
}
