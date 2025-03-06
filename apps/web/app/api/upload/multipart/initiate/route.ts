import { createS3Client, getS3Bucket } from "@/utils/s3";
import { CreateMultipartUploadCommand } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clientEnv, serverEnv } from "@cap/env";

export async function POST(request: NextRequest) {
  try {
    const { fileKey, contentType } = await request.json();

    if (!fileKey || !contentType) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
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
    if (!user) {
      return Response.json({ error: true }, { status: 401 });
    }

    try {
      const [bucket] = await db
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.ownerId, user.id));

      console.log("S3 bucket configuration:", {
        hasEndpoint: !!bucket?.endpoint,
        endpoint: bucket?.endpoint || "N/A",
        region: bucket?.region || "N/A",
        hasAccessKey: !!bucket?.accessKeyId,
        hasSecretKey: !!bucket?.secretAccessKey,
      });

      const s3Config = bucket
        ? {
            endpoint: bucket.endpoint || undefined,
            region: bucket.region,
            accessKeyId: bucket.accessKeyId,
            secretAccessKey: bucket.secretAccessKey,
            forcePathStyle: true,
          }
        : null;
        
      if (!s3Config?.endpoint && !s3Config?.region) {
        console.log("Using default S3 configuration");
      }

      const s3Client = await createS3Client(s3Config);
      const bucketName = await getS3Bucket(bucket);

      const finalContentType = contentType || "video/mp4";
      console.log(`Creating multipart upload in bucket: ${bucketName}, content-type: ${finalContentType}, key: ${fileKey}`);

      const command = new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: fileKey,
        ContentType: finalContentType,
        Metadata: {
          userId: user.id,
          source: "cap-multipart-upload",
        },
        CacheControl: "max-age=31536000",
      });

      const result = await s3Client.send(command);
      const { UploadId } = result;
      
      if (!UploadId) {
        throw new Error("No UploadId returned from S3");
      }

      console.log(`Successfully initiated multipart upload with ID: ${UploadId}`);
      console.log(`Upload details: Bucket=${bucketName}, Key=${fileKey}, ContentType=${finalContentType}`);
      
      return Response.json({ uploadId: UploadId });
    } catch (s3Error) {
      console.error("S3 operation failed:", s3Error);
      throw new Error(
        `S3 operation failed: ${
          s3Error instanceof Error ? s3Error.message : "Unknown error"
        }`
      );
    }
  } catch (error) {
    console.error("Error initiating multipart upload", error);
    return Response.json(
      {
        error: "Error initiating multipart upload",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
} 