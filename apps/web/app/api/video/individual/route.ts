import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getCurrentUser } from "@cap/database/auth/session";
import { getHeaders } from "@/utils/helpers";
import { createS3Client, getS3Bucket } from "@/utils/s3";
import { S3_BUCKET_URL } from "@cap/utils";

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
  const videoId = searchParams.get("videoId") || "";
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

  const result = query[0];
  if (!result) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      { status: 401, headers: getHeaders(origin) }
    );
  }

  const { video, bucket } = result;

  if (video.public === false) {
    const user = await getCurrentUser();

    if (!user || user.id !== video.ownerId) {
      return new Response(
        JSON.stringify({ error: true, message: "Video is not public" }),
        { status: 401, headers: getHeaders(origin) }
      );
    }
  }

  const Bucket = await getS3Bucket(bucket);
  const individualPrefix = `${userId}/${videoId}/individual/`;

  try {
    const s3Client = await createS3Client(bucket);

    const objectsCommand = new ListObjectsV2Command({
      Bucket,
      Prefix: individualPrefix,
    });

    const objects = await s3Client.send(objectsCommand);

    if (!objects.Contents || objects.Contents.length === 0) {
      return new Response(
        JSON.stringify({ error: true, message: "No individual files found" }),
        { status: 404, headers: getHeaders(origin) }
      );
    }

    const individualFiles = objects.Contents.map((object) => {
      const key = object.Key as string;
      const fileName = key.split("/").pop();
      return {
        fileName,
        url: `${S3_BUCKET_URL}/${key}`,
      };
    });

    return new Response(JSON.stringify({ files: individualFiles }), {
      status: 200,
      headers: getHeaders(origin),
    });
  } catch (error) {
    console.error("Error listing individual files", error);
    return new Response(
      JSON.stringify({
        error: true,
        message: "Error listing individual files",
      }),
      { status: 500, headers: getHeaders(origin) }
    );
  }
}
