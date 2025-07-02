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
        status: 404,
        headers: getHeaders(origin),
      }
    );
  }

  const result = query[0];
  if (!result?.video) {
    return new Response(
      JSON.stringify({ error: true, message: "Video not found" }),
      {
        status: 404,
        headers: getHeaders(origin),
      }
    );
  }

  const { video } = result;
  const prefix = `${userId}/${videoId}/`;
  const screenshotPath = `${prefix}screenshot/screen-capture.jpg`;
  let thumbnailUrl: string;

  const usePathStyle = serverEnv().S3_PATH_STYLE;
  const customBucketUrl = serverEnv().CAP_AWS_BUCKET_URL;
  const endpoint = serverEnv().CAP_AWS_ENDPOINT;

  // Handle path-style URLs
  if (usePathStyle && endpoint && video.awsBucket) {
    thumbnailUrl = `${endpoint}/${video.awsBucket}/${screenshotPath}`;
    return new Response(JSON.stringify({ screen: thumbnailUrl }), {
      status: 200,
      headers: getHeaders(origin),
    });
  }

  // Handle virtual-hosted/subdomain style URLs
  if (!usePathStyle && customBucketUrl) {
    thumbnailUrl = `${customBucketUrl}/${screenshotPath}`;
    return new Response(JSON.stringify({ screen: thumbnailUrl }), {
      status: 200,
      headers: getHeaders(origin),
    });
  }


  // Fallback if no custom URL/endpoint is configured
  if (!result.bucket || video.awsBucket === serverEnv().CAP_AWS_BUCKET) {
    thumbnailUrl = `${S3_BUCKET_URL}/${screenshotPath}`;
    return new Response(JSON.stringify({ screen: thumbnailUrl }), {
      status: 200,
      headers: getHeaders(origin),
    });
  }

  // Fallback for other custom S3 setups that require pre-signed URLs
  const bucketProvider = await createBucketProvider(result.bucket);
  try {
    thumbnailUrl = await bucketProvider.getSignedObjectUrl(screenshotPath);
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
