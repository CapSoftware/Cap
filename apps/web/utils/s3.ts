import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { s3Buckets } from "@cap/database/schema";
import { InferModel, type InferSelectModel } from "drizzle-orm";

export function createS3Client(
  opts: {
    endpoint?: string | null;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  } | null
) {
  return new S3Client({
    endpoint: opts?.endpoint ?? process.env.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
    region: opts?.region ?? process.env.NEXT_PUBLIC_CAP_AWS_REGION,
    credentials: {
      accessKeyId: opts?.accessKeyId ?? process.env.CAP_AWS_ACCESS_KEY ?? "",
      secretAccessKey:
        opts?.secretAccessKey ?? process.env.CAP_AWS_SECRET_KEY ?? "",
    },
  });
}

export function getS3Bucket(
  bucket?: InferSelectModel<typeof s3Buckets> | null
) {
  return bucket?.bucketName ?? (process.env.NEXT_PUBLIC_CAP_AWS_BUCKET || "");
}
