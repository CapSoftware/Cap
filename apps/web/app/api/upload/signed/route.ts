import { createS3Client, getS3Bucket } from "@/utils/s3";
import {
  createPresignedPost,
  type PresignedPost,
} from "@aws-sdk/s3-presigned-post";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { decrypt } from "@cap/database/crypto";

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

    const token = request.headers.get("authorization")?.split(" ")[1];
    if (token) {
      cookies().set({
        name: "next-auth.session-token",
        value: token,
        path: "/",
        sameSite: "none",
        secure: true,
        httpOnly: true,
      });
    }

    const user = await getCurrentUser();
    console.log("/api/upload/signed user", user);

    if (!user) {
      return new Response(JSON.stringify({ error: true }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    try {
      const [bucket] = await db
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.ownerId, user.id));

      // Create a decrypted config for S3 client
      const s3Config = bucket ? {
        endpoint: bucket.endpoint || undefined,
        region: bucket.region,
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
      } : null;

      console.log("Creating S3 client with config:", {
        hasEndpoint: !!s3Config?.endpoint,
        hasRegion: !!s3Config?.region,
        hasAccessKey: !!s3Config?.accessKeyId,
        hasSecretKey: !!s3Config?.secretAccessKey,
      });

      const s3Client = createS3Client(s3Config);

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

      const bucketName = getS3Bucket(bucket);
      console.log("Using bucket:", bucketName);

      const presignedPostData: PresignedPost = await createPresignedPost(
        s3Client,
        { 
          Bucket: bucketName, 
          Key: fileKey, 
          Fields, 
          Expires: 1800 
        }
      );

      console.log("Presigned URL created successfully");

      return new Response(JSON.stringify({ presignedPostData }), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (s3Error) {
      console.error("S3 operation failed:", s3Error);
      throw new Error(`S3 operation failed: ${s3Error instanceof Error ? s3Error.message : 'Unknown error'}`);
    }
  } catch (error) {
    console.error("Error creating presigned URL", error);
    return new Response(
      JSON.stringify({ 
        error: "Error creating presigned URL",
        details: error instanceof Error ? error.message : String(error)
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
