import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { videoId: string } }
) {
  const videoId = params.videoId;

  const query = await db
    .select({
      video: videos,
      bucket: s3Buckets,
    })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (query.length === 0) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }

  const result = query[0];
  if (!result?.video) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }

  const defaultBucket = {
    name: process.env.NEXT_PUBLIC_CAP_AWS_BUCKET,
    region: process.env.NEXT_PUBLIC_CAP_AWS_REGION,
    accessKeyId: process.env.CAP_AWS_ACCESS_KEY,
    secretAccessKey: process.env.CAP_AWS_SECRET_KEY,
  };

  return NextResponse.json({
    video: result.video,
    bucket: result.bucket || defaultBucket,
  });
} 