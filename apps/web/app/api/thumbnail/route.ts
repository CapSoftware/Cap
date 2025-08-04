import type { NextRequest } from "next/server";
import { getHeaders } from "@/utils/helpers";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { s3Buckets, videos } from "@cap/database/schema";
import { createBucketProvider } from "@/utils/s3";
import { S3_BUCKET_URL } from "@cap/utils";
import { serverEnv } from "@cap/env";

export const revalidate = 0;

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

  const query = await db()
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

  const result = query[0];
  if (!result?.video) {
    return new Response(
      JSON.stringify({ error: true, message: "Video not found" }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const { video } = result;
  const prefix = `${userId}/${videoId}/`;

  let thumbnailUrl: string;

  if (!result.bucket || video.awsBucket === serverEnv().CAP_AWS_BUCKET) {
    thumbnailUrl = `${S3_BUCKET_URL}/${prefix}screenshot/screen-capture.jpg`;
    return new Response(JSON.stringify({ screen: thumbnailUrl }), {
      status: 200,
      headers: getHeaders(origin),
    });
  }

  const bucketProvider = await createBucketProvider(result.bucket);

  try {
    const listResponse = await bucketProvider.listObjects({
      prefix: prefix,
    });
    const contents = listResponse.Contents || [];

    const thumbnailKey = contents.find((item: any) =>
      item.Key?.endsWith("screen-capture.jpg")
    )?.Key;

    if (!thumbnailKey) {
      return new Response(
        JSON.stringify({
          error: true,
          message: "No thumbnail found for this video",
        }),
        {
          status: 404,
          headers: getHeaders(origin),
        }
      );
    }

    thumbnailUrl = await bucketProvider.getSignedObjectUrl(thumbnailKey);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "Error generating thumbnail URL",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }

  return new Response(JSON.stringify({ screen: thumbnailUrl }), {
    status: 200,
    headers: getHeaders(origin),
  });
}
