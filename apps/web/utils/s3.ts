import { S3Client } from "@aws-sdk/client-s3";
import { s3Buckets } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";
import { decrypt } from "@cap/database/crypto";

type S3Bucket = InferSelectModel<typeof s3Buckets>;

type S3Config = {
  endpoint?: string | null;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
} | null;

async function tryDecrypt(text: string | null | undefined): Promise<string | undefined> {
  if (!text) return undefined;
  try {
    const decrypted = await decrypt(text);
    return decrypted;
  } catch (error) {
    return text;
  }
}

export async function getS3Config(config?: S3Config) {
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
    endpoint: config.endpoint ? await tryDecrypt(config.endpoint) : process.env.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
    region: (await tryDecrypt(config.region)) ?? process.env.NEXT_PUBLIC_CAP_AWS_REGION,
    credentials: {
      accessKeyId: (await tryDecrypt(config.accessKeyId)) ?? process.env.CAP_AWS_ACCESS_KEY ?? "",
      secretAccessKey: (await tryDecrypt(config.secretAccessKey)) ?? process.env.CAP_AWS_SECRET_KEY ?? "",
    },
  };
}

export async function getS3Bucket(bucket: S3Bucket | null) {
  if (!bucket) {
    return process.env.CAP_S3_BUCKET || "";
  }

  // For Supabase, we need to use the bucket name directly without any path
  if (bucket.provider === 'supabase') {
    return bucket.bucketName;
  }

  // For other providers, use existing logic
  return bucket.bucketName || process.env.CAP_S3_BUCKET || "";
}

export async function createS3Client(config?: S3Config) {
  return new S3Client(await getS3Config(config));
}
