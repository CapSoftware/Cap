import { createS3Client, getS3Bucket } from "@/utils/s3";
import {
  createPresignedPost,
  type PresignedPost,
} from "@aws-sdk/s3-presigned-post";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { fileKey, duration, bandwidth, resolution, videoCodec, audioCodec } =
      await request.json();

    if (!fileKey) {
      console.error("Missing required fields in /api/upload/signed/route.ts");

      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    const user = await getCurrentUser();

    if (!user) {
      return new Response(JSON.stringify({ error: true }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const [bucket] = await db
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));
    if (!bucket) {
      return new Response(JSON.stringify({ error: true }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const s3Client = createS3Client(bucket);

    const contentType = fileKey.endsWith(".aac")
      ? "audio/aac"
      : fileKey.endsWith(".webm")
      ? "audio/webm"
      : fileKey.endsWith(".mp4")
      ? "video/mp4"
      : fileKey.endsWith(".mp3")
      ? "audio/mpeg"
      : fileKey.endsWith(".m3u8")
      ? "application/x-mpegURL"
      : "video/mp2t";

    const Fields = {
      "Content-Type": contentType,
      "x-amz-meta-userid": user.id,
      "x-amz-meta-duration": duration ?? "",
      "x-amz-meta-bandwidth": bandwidth ?? "",
      "x-amz-meta-resolution": resolution ?? "",
      "x-amz-meta-videocodec": videoCodec ?? "",
      "x-amz-meta-audiocodec": audioCodec ?? "",
    };

    const presignedPostData: PresignedPost = await createPresignedPost(
      s3Client,
      { Bucket: getS3Bucket(bucket), Key: fileKey, Fields, Expires: 1800 }
    );

    console.log("Presigned URL created successfully");

    return new Response(JSON.stringify({ presignedPostData }), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating presigned URL", error);
    return new Response(
      JSON.stringify({ error: "Error creating presigned URL" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
