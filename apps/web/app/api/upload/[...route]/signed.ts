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
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { serverEnv } from "@cap/env";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { withAuth } from "../../utils";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand } from "@aws-sdk/client-s3";

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
      method: z.union([z.literal("post"), z.literal("put")]).default("post"),
    })
  ),
  async (c) => {
    const user = c.get("user");
    const {
      fileKey,
      duration,
      bandwidth,
      resolution,
      videoCodec,
      audioCodec,
      method,
    } = c.req.valid("json");

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

      const bucketName = await getS3Bucket(bucket);

      let data;
      if (method === "post") {
        const Fields = {
          "Content-Type": contentType,
          "x-amz-meta-userid": user.id,
          "x-amz-meta-duration": duration ?? "",
          "x-amz-meta-bandwidth": bandwidth ?? "",
          "x-amz-meta-resolution": resolution ?? "",
          "x-amz-meta-videocodec": videoCodec ?? "",
          "x-amz-meta-audiocodec": audioCodec ?? "",
        };

        data = await createPresignedPost(s3Client, {
          Bucket: bucketName,
          Key: fileKey,
          Fields,
          Expires: 1800,
        });
      } else if (method === "put") {
        const presignedUrl = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: bucketName,
            Key: fileKey,
            ContentType: contentType,
            Metadata: {
              userid: user.id,
              duration: duration ?? "",
              bandwidth: bandwidth ?? "",
              resolution: resolution ?? "",
              videocodec: videoCodec ?? "",
              audiocodec: audioCodec ?? "",
            },
          }),
          { expiresIn: 1800 }
        );

        data = { url: presignedUrl, fields: {} };
      }
      console.log({ data });

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

      if (method === "post") return c.json({ presignedPostData: data });
      else return c.json({ presignedPutData: data });
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
