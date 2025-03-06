import { createS3Client, getS3Bucket } from "@/utils/s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { UploadPartCommand } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clientEnv } from "@cap/env";

export async function POST(request: NextRequest) {
  try {
    const { fileKey, uploadId, partNumber } = await request.json();

    if (!fileKey || !uploadId || !partNumber) {
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

      const s3Config = bucket
        ? {
            endpoint: bucket.endpoint || undefined,
            region: bucket.region,
            accessKeyId: bucket.accessKeyId,
            secretAccessKey: bucket.secretAccessKey,
            forcePathStyle: true,
          }
        : null;

      const s3Client = await createS3Client(s3Config);
      const bucketName = await getS3Bucket(bucket);

      console.log(`Getting presigned URL for part ${partNumber} of upload ${uploadId}`);

      const command = new UploadPartCommand({
        Bucket: bucketName,
        Key: fileKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      let finalUrl = presignedUrl;
      
      if (bucket?.endpoint || clientEnv.NEXT_PUBLIC_CAP_AWS_ENDPOINT) {
        const endpoint = bucket?.endpoint || clientEnv.NEXT_PUBLIC_CAP_AWS_ENDPOINT;
        
        if (endpoint) {
          const urlObj = new URL(presignedUrl);
          
          const queryString = urlObj.search;
          
          if (endpoint.includes('localhost') || s3Config?.forcePathStyle) {
            finalUrl = `${endpoint}/${bucketName}/${fileKey}${queryString}`;
            
            const updatedUrl = new URL(finalUrl);
            updatedUrl.searchParams.set('partNumber', partNumber.toString());
            updatedUrl.searchParams.set('uploadId', uploadId);
            finalUrl = updatedUrl.toString();
            
            console.log(`Using path-style URL for part ${partNumber}: ${finalUrl}`);
          } else {
            finalUrl = presignedUrl;
          }
        }
      }

      console.log(`Generated presigned URL for part ${partNumber}: ${finalUrl}`);
      return Response.json({ presignedUrl: finalUrl });
    } catch (s3Error) {
      console.error("S3 operation failed:", s3Error);
      throw new Error(
        `S3 operation failed: ${
          s3Error instanceof Error ? s3Error.message : "Unknown error"
        }`
      );
    }
  } catch (error) {
    console.error("Error creating presigned URL for part", error);
    return Response.json(
      {
        error: "Error creating presigned URL for part",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
} 