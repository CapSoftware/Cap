"use server";

import { db } from "@cap/database";
import { videos, s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { nanoId } from "@cap/database/helpers";

export async function duplicateVideo(videoId: string): Promise<string> {
  if (!videoId) throw new Error("Video ID is required");

  // Get the video
  const [video] = await db()
    .select()
    .from(videos)
    .where(eq(videos.id, videoId));
  if (!video) throw new Error("Video not found");

  const newVideoId = nanoId();
  const now = new Date();

  // Insert the duplicated video
  await db()
    .insert(videos)
    .values({
      ...video,
      id: newVideoId,
      createdAt: now,
      updatedAt: now,
    });

  // Copy S3 assets
  try {
    const { createBucketProvider } = await import("@/utils/s3");
    let bucketProvider = null;
    let prefix: string | null = null;
    let newPrefix: string | null = null;
    if (video.bucket) {
      const [bucketRow] = await db()
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.id, video.bucket));
      if (bucketRow) {
        bucketProvider = await createBucketProvider(bucketRow);
        prefix = `${video.ownerId}/${video.id}/`;
        newPrefix = `${video.ownerId}/${newVideoId}/`;
      }
    } else if (video.awsBucket) {
      bucketProvider = await createBucketProvider();
      prefix = `${video.ownerId}/${video.id}/`;
      newPrefix = `${video.ownerId}/${newVideoId}/`;
    }
    if (bucketProvider && prefix && newPrefix) {
      const objects = await bucketProvider.listObjects({ prefix });
      if (objects.Contents) {
        for (const obj of objects.Contents) {
          if (!obj.Key) continue;
          const newKey = obj.Key.replace(prefix, newPrefix);
          await bucketProvider.copyObject(
            `${bucketProvider.name}/${obj.Key}`,
            newKey
          );
        }
      }
    }
  } catch (err) {
    console.error("Failed to copy S3 assets for duplicated video", err);
  }

  revalidatePath("/dashboard/caps");

  return newVideoId;
}
