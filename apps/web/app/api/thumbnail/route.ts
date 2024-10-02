import type { NextRequest } from "next/server";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getHeaders } from "@/utils/helpers";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { s3Buckets, videos } from "@cap/database/schema";
import { createS3Client, getS3Bucket } from "@/utils/s3";

export const revalidate = 3500;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const userId = searchParams.get("userId");
  const videoId = searchParams.get("videoId");
  const origin = request.headers.get("origin") as string;

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      {
        status: 400,
        headers: getHeaders(origin),
      }
    );
  }

  const query = await db
    .select({
      video: videos,
      bucket: s3Buckets,
    })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (query.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const { video, bucket } = query[0];
  const Bucket = getS3Bucket(bucket);

  const s3Client = createS3Client(bucket);
  const prefix = `${userId}/${videoId}/`;

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket,
      Prefix: prefix,
    });

    const listResponse = await s3Client.send(listCommand);
    const contents = listResponse.Contents || [];

    let thumbnailKey = contents.find((item) => item.Key?.endsWith(".png"))?.Key;

    if (!thumbnailKey) {
      thumbnailKey = `${prefix}screenshot/screen-capture.jpg`;
    }

    const thumbnailUrl = `https://v.cap.so/${thumbnailKey}`;

    return new Response(JSON.stringify({ screen: thumbnailUrl }), {
      status: 200,
      headers: getHeaders(origin),
    });
  } catch (error) {
    console.error("Error generating thumbnail URL:", error);
    return new Response(
      JSON.stringify({
        error: true,
        message: "Error generating thumbnail URL",
      }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }
}
