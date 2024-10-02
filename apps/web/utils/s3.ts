import { S3Client } from "@aws-sdk/client-s3";
import type { s3Buckets } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";

type S3Config = {
  endpoint?: string | null;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
} | null;

export function createS3Client(config?: S3Config) {
  return new S3Client(getS3Config(config));
}

export function getS3Config(config?: S3Config) {
  return {
    endpoint: config?.endpoint ?? process.env.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
    region: config?.region ?? process.env.NEXT_PUBLIC_CAP_AWS_REGION,
    credentials: {
      accessKeyId: config?.accessKeyId ?? process.env.CAP_AWS_ACCESS_KEY ?? "",
      secretAccessKey:
        config?.secretAccessKey ?? process.env.CAP_AWS_SECRET_KEY ?? "",
    },
  };
}

export function getS3Bucket(
  bucket?: InferSelectModel<typeof s3Buckets> | null
) {
  return bucket?.bucketName ?? (process.env.NEXT_PUBLIC_CAP_AWS_BUCKET || "");
}
