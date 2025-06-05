"use server";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, s3Buckets } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { createS3Client } from "@/utils/s3";

export async function getTranscript(
  videoId: string
): Promise<{ success: boolean; content?: string; message: string }> {

  const user = await getCurrentUser();

  if (!user || !videoId) {
    return {
      success: false,
      message: "Missing required data for fetching transcript",
    };
  }

  const userId = user.id;
  const query = await db()
    .select({
      video: videos,
      bucket: s3Buckets,
    })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (query.length === 0) {
    return { success: false, message: "Video not found" };
  }

  const result = query[0];
  if (!result?.video) {
    return { success: false, message: "Video information is missing" };
  }

  const { video, bucket } = result;

  if (video.ownerId !== userId) {
    return {
      success: false,
      message: "You don't have permission to access this transcript",
    };
  }

  if (video.transcriptionStatus !== "COMPLETE") {
    return {
      success: false,
      message: "Transcript is not ready yet",
    };
  }

  const awsRegion = video.awsRegion;
  const awsBucket = video.awsBucket;

  if (!awsRegion || !awsBucket) {
    return {
      success: false,
      message: "AWS region or bucket information is missing",
    };
  }
  const [s3Client] = await createS3Client(bucket);

  try {
    const transcriptKey = `${video.ownerId}/${videoId}/transcription.vtt`;

    const getCommand = new GetObjectCommand({
      Bucket: awsBucket,
      Key: transcriptKey,
    });

    const response = await s3Client.send(getCommand);
    const vttContent = await response.Body?.transformToString();

    if (!vttContent) {
      return { success: false, message: "Transcript file not found" };
    }

    return {
      success: true,
      content: vttContent,
      message: "Transcript retrieved successfully",
    };
  } catch (error) {
    console.error("[getTranscript] Error fetching transcript:", {
      error: error instanceof Error ? error.message : error,
      videoId,
      userId
    });
    return {
      success: false,
      message: "Failed to fetch transcript",
    };
  }
} 