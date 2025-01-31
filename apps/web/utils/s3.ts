import { S3Client } from "@aws-sdk/client-s3";
import type { s3Buckets } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";
import { decrypt } from "@cap/database/crypto";
import { clientEnv, serverEnv } from "@cap/env";

type S3Config = {
  endpoint?: string | null;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
} | null;

async function tryDecrypt(
  text: string | null | undefined
): Promise<string | undefined> {
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
      endpoint: clientEnv.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
      region: clientEnv.NEXT_PUBLIC_CAP_AWS_REGION,
      credentials: {
        accessKeyId: serverEnv.CAP_AWS_ACCESS_KEY ?? "",
        secretAccessKey: serverEnv.CAP_AWS_SECRET_KEY ?? "",
      },
    };
  }

  return {
    endpoint: config.endpoint
      ? await tryDecrypt(config.endpoint)
      : clientEnv.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
    region:
      (await tryDecrypt(config.region)) ?? clientEnv.NEXT_PUBLIC_CAP_AWS_REGION,
    credentials: {
      accessKeyId:
        (await tryDecrypt(config.accessKeyId)) ??
        serverEnv.CAP_AWS_ACCESS_KEY ??
        "",
      secretAccessKey:
        (await tryDecrypt(config.secretAccessKey)) ??
        serverEnv.CAP_AWS_SECRET_KEY ??
        "",
    },
  };
}

export async function getS3Bucket(
  bucket?: InferSelectModel<typeof s3Buckets> | null
) {
  if (!bucket?.bucketName) {
    return clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET || "";
  }

  return (
    ((await tryDecrypt(bucket.bucketName)) ??
      clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET) ||
    ""
  );
}

export async function createS3Client(config?: S3Config) {
  return new S3Client(await getS3Config(config));
}
