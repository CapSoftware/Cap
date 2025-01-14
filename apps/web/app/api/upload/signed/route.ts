import { createS3Client, getS3Bucket } from "@/utils/s3";
import {
  createPresignedPost,
  type PresignedPost,
} from "@aws-sdk/s3-presigned-post";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets } from "@cap/database/schema";
import { decrypt } from "@cap/database/crypto";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";

function maskString(str: string): string {
  if (!str) return '';
  if (str.length <= 8) return '*'.repeat(str.length);
  return str.slice(0, 4) + '*'.repeat(str.length - 8) + str.slice(-4);
}

export async function POST(request: NextRequest) {
  try {
    const { fileKey, duration, bandwidth, resolution, videoCodec, audioCodec } =
      await request.json();

    const contentType = fileKey.endsWith(".jpg") || fileKey.endsWith(".jpeg")
      ? "image/jpeg"
      : fileKey.endsWith(".aac")
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

    console.log("Upload request received for file:", {
      fileKey,
      contentType,
      fileSize: request.headers.get("content-length"),
    });

    if (!fileKey) {
      console.error("Missing required fields in /api/upload/signed/route.ts");
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
    console.log("/api/upload/signed user", user);

    if (!user) {
      return Response.json({ error: true }, { status: 401 });
    }

    try {
      const [bucket] = await db
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.ownerId, user.id));

      console.log("Found S3 bucket configuration:", {
        hasCustomBucket: !!bucket,
        provider: bucket?.provider,
        hasEndpoint: !!bucket?.endpoint,
      });

      const s3Config = bucket
        ? {
            endpoint: bucket.endpoint || undefined,
            region: bucket.region,
            accessKeyId: bucket.accessKeyId,
            secretAccessKey: bucket.secretAccessKey,
            provider: bucket.provider,
          }
        : null;

      if (!bucket || !s3Config) {
        const distributionId = process.env.CAP_CLOUDFRONT_DISTRIBUTION_ID;
        if (distributionId) {
          console.log("Creating CloudFront invalidation for", fileKey);

          const cloudfront = new CloudFrontClient({
            region: process.env.NEXT_PUBLIC_CAP_AWS_REGION || "us-east-1",
            credentials: {
              accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
              secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
            },
          });

          const pathToInvalidate = "/" + fileKey;

          try {
            const invalidation = await cloudfront.send(
              new CreateInvalidationCommand({
                DistributionId: distributionId,
                InvalidationBatch: {
                  CallerReference: `${Date.now()}`,
                  Paths: {
                    Quantity: 1,
                    Items: [pathToInvalidate],
                  },
                },
              })
            );
            console.log("CloudFront invalidation created:", invalidation);
          } catch (error) {
            console.error("Failed to create CloudFront invalidation:", error);
          }
        }
      }

      console.log("Creating S3 client with config:", {
        hasEndpoint: !!s3Config?.endpoint,
        hasRegion: !!s3Config?.region,
        hasAccessKey: !!s3Config?.accessKeyId,
        hasSecretKey: !!s3Config?.secretAccessKey,
      });

      if (!s3Config?.accessKeyId || !s3Config?.secretAccessKey || !s3Config?.region) {
        throw new Error("Missing required S3 configuration");
      }

      const isSupabase = s3Config.provider === 'supabase';

      // Decrypt the configuration values
      const decryptedEndpoint = await decrypt(s3Config.endpoint || '');
      const decryptedRegion = await decrypt(s3Config.region);
      const decryptedAccessKey = await decrypt(s3Config.accessKeyId);
      const decryptedSecretKey = await decrypt(s3Config.secretAccessKey);


      const s3Client = new S3Client({
        endpoint: decryptedEndpoint,
        region: decryptedRegion,
        credentials: {
          accessKeyId: decryptedAccessKey,
          secretAccessKey: decryptedSecretKey,
        },
        forcePathStyle: isSupabase,
        ...(isSupabase && {
          customUserAgent: 'cap-app',
          maxAttempts: 3
        })
      });

      const Fields = {
        "Content-Type": contentType,
        "x-amz-meta-userid": user.id,
        "x-amz-meta-duration": duration ?? "",
        "x-amz-meta-bandwidth": bandwidth ?? "",
        "x-amz-meta-resolution": resolution ?? "",
        "x-amz-meta-videocodec": videoCodec ?? "",
        "x-amz-meta-audiocodec": audioCodec ?? "",
      };

      const bucketName = await decrypt(await getS3Bucket(bucket || null));

      console.log("Preparing presigned post request:", {
        bucketName,
        fileKey,
        isSupabase,
        expires: 1800,
      });

      try {
        const presignedPostData: PresignedPost = await createPresignedPost(
          s3Client,
          {
            Bucket: bucketName,
            Key: fileKey,
            Fields: {
              ...Fields,
              "Content-Type": contentType,
            },
            Expires: 1800,
            Conditions: [
              ["content-length-range", 0, 1000000000], // 0-1GB
              ["eq", "$Content-Type", contentType],
            ],
          }
        );

        console.log("Successfully created presigned post URL:", {
          url: presignedPostData.url,
          hasFields: !!presignedPostData.fields,
          fieldKeys: Object.keys(presignedPostData.fields),
          contentType,
          conditions: [
            ["content-length-range", 0, 1000000000],
            ["eq", "$Content-Type", contentType],
          ],
        });

        return Response.json({ 
          presignedPostData,
          debug: {
            provider: s3Config?.provider,
            bucketName,
            fileKey,
            contentType,
            url: presignedPostData.url,
            fields: presignedPostData.fields,
          }
        });

      } catch (s3Error) {
        console.error("Failed to create presigned post URL:", {
          error: s3Error instanceof Error ? s3Error.message : s3Error,
          bucketName,
          fileKey,
          endpoint: s3Client.config.endpoint,
        });
        throw s3Error;
      }
    } catch (s3Error) {
      console.error("S3 operation failed:", s3Error);
      throw new Error(
        `S3 operation failed: ${
          s3Error instanceof Error ? s3Error.message : "Unknown error"
        }`
      );
    }
  } catch (error) {
    console.error("Upload route error:", {
      error: error instanceof Error ? error.message : error,
    });
    return Response.json(
      {
        error: "Error creating presigned URL",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
