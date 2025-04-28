"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, eq } from "drizzle-orm";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createS3Client, getS3Bucket } from "@/utils/s3";

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

    const query = await db
      .select({ video: videos, bucket: s3Buckets })
      .from(videos)
      .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
      .where(eq(videos.id, videoId));

    if (query.length === 0) {
      return {
        success: false,
        message: "Video does not exist",
      };
    }

    const result = query[0];
    if (!result) {
      return {
        success: false,
        message: "Video not found",
      };
    }

    await db
      .delete(videos)
      .where(and(eq(videos.id, videoId), eq(videos.ownerId, userId)));

    const [s3Client] = await createS3Client(result.bucket);
    const Bucket = await getS3Bucket(result.bucket);
    const prefix = `${userId}/${videoId}/`;

    const listObjectsCommand = new ListObjectsV2Command({
      Bucket,
      Prefix: prefix,
    });

    const listedObjects = await s3Client.send(listObjectsCommand);

    if (listedObjects.Contents?.length) {
      const deleteObjectsCommand = new DeleteObjectsCommand({
        Bucket,
        Delete: {
          Objects: listedObjects.Contents.map((content: any) => ({
            Key: content.Key,
          })),
        },
      });

      await s3Client.send(deleteObjectsCommand);
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