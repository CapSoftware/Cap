import { Hono } from "hono";
import { createBucketProvider } from "@/utils/s3";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { serverEnv } from "@cap/env";
import { withAuth } from "@/app/api/utils";
import { parseVideoIdOrFileKey } from "../utils";
import { VideoMetadata } from "@cap/database/types";

export const app = new Hono().use(withAuth);

app.post(
  "/initiate",
  zValidator(
    "json",
    z.object({ contentType: z.string() }).and(
      z.union([
        z.object({ videoId: z.string() }),
        // deprecated
        z.object({ fileKey: z.string() }),
      ])
    )
  ),
  async (c) => {
    const { contentType, ...body } = c.req.valid("json");
    const user = c.get("user");

    const fileKey = parseVideoIdOrFileKey(user.id, {
      ...body,
      subpath: "result.mp4",
    });

    try {
      try {
        const { bucket } = await getUserBucketWithClient(user.id);

        const finalContentType = contentType || "video/mp4";
        console.log(
          `Creating multipart upload in bucket: ${bucket.name}, content-type: ${finalContentType}, key: ${fileKey}`
        );

        const { UploadId } = await bucket.multipart.create(fileKey, {
          ContentType: finalContentType,
          Metadata: {
            userId: user.id,
            source: "cap-multipart-upload",
          },
          CacheControl: "max-age=31536000",
        });

        if (!UploadId) {
          throw new Error("No UploadId returned from S3");
        }

        console.log(
          `Successfully initiated multipart upload with ID: ${UploadId}`
        );
        console.log(
          `Upload details: Bucket=${bucket.name}, Key=${fileKey}, ContentType=${finalContentType}`
        );

        return c.json({ uploadId: UploadId });
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
      return c.json(
        {
          error: "Error initiating multipart upload",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }
);

app.post(
  "/presign-part",
  zValidator(
    "json",
    z
      .object({
        uploadId: z.string(),
        partNumber: z.number(),
        md5Sum: z.string(),
      })
      .and(
        z.union([
          z.object({ videoId: z.string() }),
          // deprecated
          z.object({ fileKey: z.string() }),
        ])
      )
  ),
  async (c) => {
    const { uploadId, partNumber, md5Sum, ...body } = c.req.valid("json");
    const user = c.get("user");

    const fileKey = parseVideoIdOrFileKey(user.id, {
      ...body,
      subpath: "result.mp4",
    });

    try {
      try {
        const { bucket } = await getUserBucketWithClient(user.id);

        console.log(
          `Getting presigned URL for part ${partNumber} of upload ${uploadId}`
        );

        const presignedUrl = await bucket.multipart.getPresignedUploadPartUrl(
          fileKey,
          uploadId,
          partNumber,
          { ContentMD5: md5Sum }
        );

        return c.json({ presignedUrl });
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
      return c.json(
        {
          error: "Error creating presigned URL for part",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }
);

app.post(
  "/complete",
  zValidator(
    "json",
    z
      .object({
        uploadId: z.string(),
        parts: z.array(
          z.object({
            partNumber: z.number(),
            etag: z.string(),
            size: z.number(),
          })
        ),
        duration: z.string().optional(),
        bandwidth: z.string().optional(),
        resolution: z.string().optional(),
        videoCodec: z.string().optional(),
        audioCodec: z.string().optional(),
        framerate: z.string().optional(),
      })
      .and(
        z.union([
          z.object({ videoId: z.string() }),
          // deprecated
          z.object({ fileKey: z.string() }),
        ])
      )
  ),
  async (c) => {
    const { uploadId, parts, ...body } = c.req.valid("json");
    const user = c.get("user");

    const fileKey = parseVideoIdOrFileKey(user.id, {
      ...body,
      subpath: "result.mp4",
    });

    try {
      try {
        const { bucket } = await getUserBucketWithClient(user.id);

        console.log(
          `Completing multipart upload ${uploadId} with ${parts.length} parts for key: ${fileKey}`
        );

        const totalSize = parts.reduce((acc, part) => acc + part.size, 0);
        console.log(`Total size of all parts: ${totalSize} bytes`);

        const sortedParts = [...parts].sort(
          (a, b) => a.partNumber - b.partNumber
        );

        const sequentialCheck = sortedParts.every(
          (part, index) => part.partNumber === index + 1
        );

        if (!sequentialCheck) {
          console.warn(
            "WARNING: Part numbers are not sequential! This may cause issues with the assembled file."
          );
        }

        const formattedParts = sortedParts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
        }));

        console.log(
          "Sending to S3:",
          JSON.stringify(
            {
              Bucket: bucket.name,
              Key: fileKey,
              UploadId: uploadId,
              Parts: formattedParts,
            },
            null,
            2
          )
        );

        const result = await bucket.multipart.complete(fileKey, uploadId, {
          MultipartUpload: {
            Parts: formattedParts,
          },
        });

        try {
          console.log(
            `Multipart upload completed successfully: ${
              result.Location || "no location"
            }`
          );
          console.log(`Complete response: ${JSON.stringify(result, null, 2)}`);

          try {
            console.log(
              "Performing metadata fix by copying the object to itself..."
            );

            const copyResult = await bucket.copyObject(
              `${bucket.name}/${fileKey}`,
              fileKey,
              {
                ContentType: "video/mp4",
                MetadataDirective: "REPLACE",
              }
            );

            console.log("Copy for metadata fix successful:", copyResult);
          } catch (copyError) {
            console.error(
              "Warning: Failed to copy object to fix metadata:",
              copyError
            );
          }

          try {
            const headResult = await bucket.headObject(fileKey);
            console.log(
              `Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`
            );
          } catch (headError) {
            console.error(`Warning: Unable to verify object: ${headError}`);
          }

          const videoMetadata: VideoMetadata = {
            duration: body.duration,
            bandwidth: body.bandwidth,
            resolution: body.resolution,
            videoCodec: body.videoCodec,
            audioCodec: body.audioCodec,
            framerate: body.framerate,
          };

          if (Object.values(videoMetadata).length > 1 && "videoId" in body)
            await db()
              .update(videos)
              .set({
                metadata: videoMetadata,
              })
              .where(eq(videos.id, body.videoId));

          const videoIdFromFileKey = fileKey.split("/")[1];
          if (videoIdFromFileKey) {
            try {
              await fetch(`${serverEnv().WEB_URL}/api/revalidate`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ videoId: videoIdFromFileKey }),
              });
              console.log(
                `Revalidation triggered for videoId: ${videoIdFromFileKey}`
              );
            } catch (revalidateError) {
              console.error("Failed to revalidate page:", revalidateError);
            }
          }

          return c.json({
            location: result.Location,
            success: true,
            fileKey,
          });
        } catch (completeError) {
          console.error("Failed to complete multipart upload:", completeError);
          return c.json(
            {
              error: "Failed to complete multipart upload",
              details:
                completeError instanceof Error
                  ? completeError.message
                  : String(completeError),
              uploadId,
              fileKey,
              parts: formattedParts.length,
            },
            500
          );
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
      console.error("Error completing multipart upload", error);
      return c.json(
        {
          error: "Error completing multipart upload",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }
);

async function getUserBucketWithClient(userId: string) {
  const [customBucket] = await db()
    .select()
    .from(s3Buckets)
    .where(eq(s3Buckets.ownerId, userId));

  console.log("S3 bucket configuration:", {
    hasEndpoint: !!customBucket?.endpoint,
    endpoint: customBucket?.endpoint || "N/A",
    region: customBucket?.region || "N/A",
    hasAccessKey: !!customBucket?.accessKeyId,
    hasSecretKey: !!customBucket?.secretAccessKey,
  });

  const bucket = await createBucketProvider(customBucket);

  return { bucket };
}
