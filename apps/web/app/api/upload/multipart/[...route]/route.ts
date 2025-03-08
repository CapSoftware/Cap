import { Hono } from "hono";
import { createS3Client, getS3Bucket } from "@/utils/s3";
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { clientEnv } from "@cap/env";
import { handle } from "hono/vercel";
import { withAuth, corsMiddleware } from "@/app/api/utils";

const app = new Hono()
  .basePath("/api/upload/multipart")
  .use(corsMiddleware)
  .use(withAuth);

app.post(
  "/initiate",
  zValidator(
    "json",
    z.object({ fileKey: z.string(), contentType: z.string() })
  ),
  async (c) => {
    const { fileKey, contentType } = c.req.valid("json");
    const user = c.get("user");

    try {
      try {
        const { s3Client, bucketName } = await getUserBucketWithClient(user.id);

        const finalContentType = contentType || "video/mp4";
        console.log(
          `Creating multipart upload in bucket: ${bucketName}, content-type: ${finalContentType}, key: ${fileKey}`
        );

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

        console.log(
          `Successfully initiated multipart upload with ID: ${UploadId}`
        );
        console.log(
          `Upload details: Bucket=${bucketName}, Key=${fileKey}, ContentType=${finalContentType}`
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
    z.object({
      fileKey: z.string(),
      uploadId: z.string(),
      partNumber: z.number(),
      md5Sum: z.string(),
    })
  ),
  async (c) => {
    const { fileKey, uploadId, partNumber, md5Sum } = c.req.valid("json");
    const user = c.get("user");

    try {
      try {
        const { s3Client, bucketName } = await getUserBucketWithClient(user.id);

        console.log(
          `Getting presigned URL for part ${partNumber} of upload ${uploadId}`
        );

        const command = new UploadPartCommand({
          Bucket: bucketName,
          Key: fileKey,
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentMD5: md5Sum,
        });

        const presignedUrl = await getSignedUrl(s3Client, command, {
          expiresIn: 3600,
        });

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
    z.object({
      fileKey: z.string(),
      uploadId: z.string(),
      parts: z.array(
        z.object({
          partNumber: z.number(),
          etag: z.string(),
          size: z.number(),
        })
      ),
    })
  ),
  async (c) => {
    const { fileKey, uploadId, parts } = c.req.valid("json");
    const user = c.get("user");

    try {
      try {
        const { s3Client, bucketName } = await getUserBucketWithClient(user.id);

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
              Bucket: bucketName,
              Key: fileKey,
              UploadId: uploadId,
              Parts: formattedParts,
            },
            null,
            2
          )
        );

        const command = new CompleteMultipartUploadCommand({
          Bucket: bucketName,
          Key: fileKey,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: formattedParts,
          },
        });

        try {
          const result = await s3Client.send(command);
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
            const copyCommand = new CopyObjectCommand({
              Bucket: bucketName,
              CopySource: `${bucketName}/${fileKey}`,
              Key: fileKey,
              ContentType: "video/mp4",
              MetadataDirective: "REPLACE",
            });

            const copyResult = await s3Client.send(copyCommand);
            console.log("Copy for metadata fix successful:", copyResult);
          } catch (copyError) {
            console.error(
              "Warning: Failed to copy object to fix metadata:",
              copyError
            );
          }

          try {
            const headCommand = new HeadObjectCommand({
              Bucket: bucketName,
              Key: fileKey,
            });

            const headResult = await s3Client.send(headCommand);
            console.log(
              `Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`
            );
          } catch (headError) {
            console.error(`Warning: Unable to verify object: ${headError}`);
          }

          const videoId = fileKey.split("/")[1];
          if (videoId) {
            try {
              await fetch(`${clientEnv.NEXT_PUBLIC_WEB_URL}/api/revalidate`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ videoId }),
              });
              console.log(`Revalidation triggered for videoId: ${videoId}`);
            } catch (revalidateError) {
              console.error("Failed to revalidate page:", revalidateError);
            }
          }

          return c.json({
            location: result.Location,
            success: true,
            fileKey,
            bucketName,
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
  const [bucket] = await db
    .select()
    .from(s3Buckets)
    .where(eq(s3Buckets.ownerId, userId));

  console.log("S3 bucket configuration:", {
    hasEndpoint: !!bucket?.endpoint,
    endpoint: bucket?.endpoint || "N/A",
    region: bucket?.region || "N/A",
    hasAccessKey: !!bucket?.accessKeyId,
    hasSecretKey: !!bucket?.secretAccessKey,
  });

  const initialS3Config = bucket
    ? {
        endpoint: bucket.endpoint || undefined,
        region: bucket.region,
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        forcePathStyle: true,
      }
    : null;

  if (!initialS3Config?.endpoint && !initialS3Config?.region) {
    console.log("Using default S3 configuration");
  }

  const [s3Client, s3Config] = await createS3Client(initialS3Config);
  const bucketName = await getS3Bucket(bucket);

  return { s3Client, s3Config, bucketName };
}

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
