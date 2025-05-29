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
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { serverEnv } from "@cap/env";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { handle } from "hono/vercel";

import { corsMiddleware, withAuth } from "../../utils";

export const app = new Hono().use(withAuth);

app.post(
  "/",
  zValidator(
    "json",
    z.object({
      fileKey: z.string(),
      duration: z.string().optional(),
      bandwidth: z.string().optional(),
      resolution: z.string().optional(),
      videoCodec: z.string().optional(),
      audioCodec: z.string().optional(),
    })
  ),
  async (c) => {
    const user = c.get("user");
    const { fileKey, duration, bandwidth, resolution, videoCodec, audioCodec } =
      c.req.valid("json");

    try {
      const [bucket] = await db()
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.ownerId, user.id));

      const s3Config = bucket
        ? {
            endpoint: bucket.endpoint || undefined,
            region: bucket.region,
            accessKeyId: bucket.accessKeyId,
            secretAccessKey: bucket.secretAccessKey,
          }
        : null;

      if (
        !bucket ||
        !s3Config ||
        bucket.bucketName !== serverEnv().CAP_AWS_BUCKET
      ) {
        const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
        if (distributionId) {
          console.log("Creating CloudFront invalidation for", fileKey);

          const cloudfront = new CloudFrontClient({
            region: serverEnv().CAP_AWS_REGION || "us-east-1",
            credentials: {
              accessKeyId: serverEnv().CAP_AWS_ACCESS_KEY || "",
              secretAccessKey: serverEnv().CAP_AWS_SECRET_KEY || "",
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

      const [s3Client] = await createS3Client(s3Config);

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

      const bucketName = await getS3Bucket(bucket);

      const presignedPostData: PresignedPost = await createPresignedPost(
        s3Client,
        { Bucket: bucketName, Key: fileKey, Fields, Expires: 1800 }
      );

      // When not using aws s3, we need to transform the url to the local endpoint
      if (
        serverEnv().CAP_AWS_BUCKET_URL &&
        !serverEnv().CAP_AWS_ENDPOINT?.endsWith("s3-accelerate.amazonaws.com")
      ) {
        const endpoint = serverEnv().CAP_AWS_ENDPOINT;
        const bucket = serverEnv().CAP_AWS_BUCKET;
        const newUrl = `${endpoint}/${bucket}/`;
        presignedPostData.url = newUrl;
      }

      console.log("Presigned URL created successfully");

      // After successful presigned URL creation, trigger revalidation
      const videoId = fileKey.split("/")[1]; // Assuming fileKey format is userId/videoId/...
      if (videoId) {
        try {
          await fetch(`${serverEnv().WEB_URL}/api/revalidate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ videoId }),
          });
        } catch (revalidateError) {
          console.error("Failed to revalidate page:", revalidateError);
        }
      }

      return c.json({ presignedPostData });
    } catch (s3Error) {
      console.error("S3 operation failed:", s3Error);
      throw new Error(
        `S3 operation failed: ${
          s3Error instanceof Error ? s3Error.message : "Unknown error"
        }`
      );
    }
  }
);
