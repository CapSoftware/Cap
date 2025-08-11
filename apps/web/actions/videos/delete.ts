"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, eq } from "drizzle-orm";
import { createBucketProvider } from "@/utils/s3";

export async function deleteVideo(videoId: string) {
  try {
    const user = await getCurrentUser();
    const userId = user?.id;

    if (!videoId || !userId) {
      return {
        success: false,
        message: "Missing required data",
      };
    }

    const query = await db()
      .select({ video: videos, bucket: s3Buckets })
      .from(videos)
      .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
      .where(eq(videos.id, videoId));

    if (!query[0]) {
      return {
        success: false,
        message: "Video not found",
      };
    }

    await db()
      .delete(videos)
      .where(and(eq(videos.id, videoId), eq(videos.ownerId, userId)));

    const bucket = await createBucketProvider(query[0].bucket);
    const prefix = `${userId}/${videoId}/`;

    const listedObjects = await bucket.listObjects({
      prefix: prefix,
    });

    if (listedObjects.Contents?.length) {
      await bucket.deleteObjects(
        listedObjects.Contents.map((content) => ({
          Key: content.Key,
        }))
      );
    }

    return {
      success: true,
      message: "Video deleted successfully",
    };
  } catch (error) {
    console.error("Error deleting video:", error);
    return {
      success: false,
      message: "Failed to delete video",
    };
  }
}
