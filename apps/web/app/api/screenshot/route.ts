import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getCurrentUser } from "@cap/database/auth/session";
import { getHeaders } from "@/utils/helpers";
import { createS3Client, getS3Bucket } from "@/utils/s3";

export const revalidate = 3599;

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
  const videoId = searchParams.get("screenshotId") || "";
  const origin = request.headers.get("origin") as string;

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      { status: 401, headers: getHeaders(origin) }
    );
  }

  const query = await db
    .select({ video: videos, bucket: s3Buckets })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (query.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      { status: 401, headers: getHeaders(origin) }
    );
  }

  const { video, bucket } = query[0];

  if (video.public === false) {
    const user = await getCurrentUser();

    if (!user || user.id !== video.ownerId) {
      return new Response(
        JSON.stringify({ error: true, message: "Video is not public" }),
        { status: 401, headers: getHeaders(origin) }
      );
    }
  }

  const Bucket = getS3Bucket(bucket);
  const screenshotPrefix = `${userId}/${videoId}/`;

  try {
    const s3Client = createS3Client(bucket);

    const objectsCommand = new ListObjectsV2Command({
      Bucket,
      Prefix: screenshotPrefix,
      MaxKeys: 1,
    });

    const objects = await s3Client.send(objectsCommand);

    const screenshot = objects.Contents?.find((object) =>
      object.Key?.endsWith(".png")
    );

    if (!screenshot) {
      return new Response(
        JSON.stringify({ error: true, message: "Screenshot not found" }),
        { status: 404, headers: getHeaders(origin) }
      );
    }

    const screenshotUrl = `https://v.cap.so/${screenshot.Key}`;

    return new Response(JSON.stringify({ url: screenshotUrl }), {
      status: 200,
      headers: getHeaders(origin),
    });
  } catch (error) {
    console.error("Error generating screenshot URL", error);
    return new Response(
      JSON.stringify({
        error: error,
        message: "Error generating screenshot URL",
      }),
      { status: 500, headers: getHeaders(origin) }
    );
  }
}
