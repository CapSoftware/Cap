import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, eq } from "drizzle-orm";
import { getHeaders } from "@/utils/helpers";
import { createBucketProvider } from "@/utils/s3";

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  const { searchParams } = request.nextUrl;
  const videoId = searchParams.get("videoId") || "";
  const userId = user?.id as string;
  const origin = request.headers.get("origin") as string;

  if (!videoId || !userId) {
    console.error("Missing required data in /api/video/delete/route.ts");

    return Response.json({ error: true }, { status: 401 });
  }

  const query = await db()
    .select({ video: videos, bucket: s3Buckets })
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
  if (!result) {
    return new Response(
      JSON.stringify({ error: true, message: "Video not found" }),
      {
        status: 404,
        headers: getHeaders(origin),
      }
    );
  }

  await db()
    .delete(videos)
    .where(and(eq(videos.id, videoId), eq(videos.ownerId, userId)));

  const bucketProvider = await createBucketProvider(result.bucket);
  const prefix = `${userId}/${videoId}/`;

  const listedObjects = await bucketProvider.listObjects({
    prefix: prefix,
  });

  if (listedObjects.Contents?.length) {
    await bucketProvider.deleteObjects(
      listedObjects.Contents.map((content) => ({
        Key: content.Key,
      }))
    );
  }

  return Response.json(true, {
    status: 200,
  });
}
