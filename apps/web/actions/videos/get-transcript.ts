"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { videos, s3Buckets } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { createBucketProvider } from "@/utils/s3";

export async function getTranscript(
  videoId: string
): Promise<{ success: boolean; content?: string; message: string }> {
  const user = await getCurrentUser();

  if (!videoId) {
    return {
      success: false,
      message: "Missing required data for fetching transcript",
    };
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
    return { success: false, message: "Video not found" };
  }

  const result = query[0];
  if (!result?.video) {
    return { success: false, message: "Video information is missing" };
  }

  const { video } = result;

  if (video.transcriptionStatus !== "COMPLETE") {
    return {
      success: false,
      message: "Transcript is not ready yet",
    };
  }

  const bucket = await createBucketProvider(result.bucket);

  try {
    const transcriptKey = `${video.ownerId}/${videoId}/transcription.vtt`;

    const vttContent = await bucket.getObject(transcriptKey);

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
      userId: user?.id,
    });
    return {
      success: false,
      message: "Failed to fetch transcript",
    };
  }
}
