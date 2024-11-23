import { S3Client } from "@aws-sdk/client-s3";
import type { s3Buckets } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";
import { decrypt } from "@cap/database/crypto";

type S3Config = {
  endpoint?: string | null;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
} | null;

export function createS3Client(config?: S3Config) {
  return new S3Client(getS3Config(config));
}

function tryDecrypt(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  try {
    return decrypt(text);
  } catch (error) {
    // If decryption fails, assume the data is not encrypted yet
    console.log("Decryption failed, using original value");
    return text;
  }
}

export function getS3Config(config?: S3Config) {
  if (!config) {
    return {
      endpoint: process.env.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
      region: process.env.NEXT_PUBLIC_CAP_AWS_REGION,
      credentials: {
        accessKeyId: process.env.CAP_AWS_ACCESS_KEY ?? "",
        secretAccessKey: process.env.CAP_AWS_SECRET_KEY ?? "",
      },
    };
  }

  return {
    endpoint: config.endpoint ? tryDecrypt(config.endpoint) : process.env.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
    region: tryDecrypt(config.region) ?? process.env.NEXT_PUBLIC_CAP_AWS_REGION,
    credentials: {
      accessKeyId: tryDecrypt(config.accessKeyId) ?? process.env.CAP_AWS_ACCESS_KEY ?? "",
      secretAccessKey: tryDecrypt(config.secretAccessKey) ?? process.env.CAP_AWS_SECRET_KEY ?? "",
    },
  };
}

export function getS3Bucket(
  bucket?: InferSelectModel<typeof s3Buckets> | null
) {
  if (!bucket?.bucketName) {
    return process.env.NEXT_PUBLIC_CAP_AWS_BUCKET || "";
  }

  return (tryDecrypt(bucket.bucketName) ?? process.env.NEXT_PUBLIC_CAP_AWS_BUCKET) || "";
}
