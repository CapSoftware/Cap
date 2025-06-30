import { createBucketProvider } from "@/utils/s3";
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
import { parseVideoIdOrFileKey } from "../utils";

export const app = new Hono().use(withAuth);

app.post(
  "/",
  zValidator(
    "json",
    z
      .object({
        duration: z.string().optional(),
        bandwidth: z.string().optional(),
        resolution: z.string().optional(),
        videoCodec: z.string().optional(),
        audioCodec: z.string().optional(),
        method: z.union([z.literal("post"), z.literal("put")]).default("post"),
      })
      .and(
        z.union([
          // DEPRECATED
          z.object({ fileKey: z.string() }),
          z.object({ videoId: z.string(), subpath: z.string() }),
        ])
      )
  ),
  async (c) => {
    const user = c.get("user");
    const {
      duration,
      bandwidth,
      resolution,
      videoCodec,
      audioCodec,
      method,
      ...body
    } = c.req.valid("json");

    const fileKey = parseVideoIdOrFileKey(user.id, body);

    try {
      const [customBucket] = await db()
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.ownerId, user.id));

      const s3Config = customBucket
        ? {
            endpoint: customBucket.endpoint || undefined,
            region: customBucket.region,
            accessKeyId: customBucket.accessKeyId,
            secretAccessKey: customBucket.secretAccessKey,
          }
        : null;

      if (
        !customBucket ||
        !s3Config ||
        customBucket.bucketName !== serverEnv().CAP_AWS_BUCKET
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

      const bucket = await createBucketProvider(customBucket);

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

        data = bucket.getPresignedPostUrl(fileKey, { Fields, Expires: 1800 });
      } else if (method === "put") {
        const presignedUrl = await bucket.getPresignedPutUrl(
          fileKey,
          {
            ContentType: contentType,
            Metadata: {
              userid: user.id,
              duration: duration ?? "",
              bandwidth: bandwidth ?? "",
              resolution: resolution ?? "",
              videocodec: videoCodec ?? "",
              audiocodec: audioCodec ?? "",
            },
          },
          { expiresIn: 1800 }
        );

        data = { url: presignedUrl, fields: {} };
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
