import { S3Client } from "@aws-sdk/client-s3";
import type { s3Buckets } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";
import { decrypt } from "@cap/database/crypto";
import { serverEnv } from "@cap/env";

type S3Config = {
  endpoint?: string | null;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
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
      endpoint: serverEnv().CAP_AWS_ENDPOINT,
      region: serverEnv().CAP_AWS_REGION,
      credentials: {
        accessKeyId: serverEnv().CAP_AWS_ACCESS_KEY ?? "",
        secretAccessKey: serverEnv().CAP_AWS_SECRET_KEY ?? "",
      },
      forcePathStyle: serverEnv().S3_PATH_STYLE,
    };
  }

  const endpoint = config.endpoint
    ? await tryDecrypt(config.endpoint)
    : serverEnv().CAP_AWS_ENDPOINT;

  const region =
    (await tryDecrypt(config.region)) ?? serverEnv().CAP_AWS_REGION;

  const finalRegion = endpoint?.includes("localhost") ? "us-east-1" : region;

  const isLocalOrMinio =
    endpoint?.includes("localhost") || endpoint?.includes("127.0.0.1");

  return {
    endpoint,
    region: finalRegion,
    credentials: {
      accessKeyId:
        (await tryDecrypt(config.accessKeyId)) ??
        serverEnv().CAP_AWS_ACCESS_KEY ??
        "",
      secretAccessKey:
        (await tryDecrypt(config.secretAccessKey)) ??
        serverEnv().CAP_AWS_SECRET_KEY ??
        "",
    },
    forcePathStyle: config.forcePathStyle ?? true,
    useArnRegion: false,
    requestHandler: {
      connectionTimeout: isLocalOrMinio ? 5000 : 10000,
      socketTimeout: isLocalOrMinio ? 30000 : 60000,
    },
  };
}

export async function getS3Bucket(
  bucket?: InferSelectModel<typeof s3Buckets> | null
) {
  if (!bucket?.bucketName) {
    return serverEnv().CAP_AWS_BUCKET || "";
  }

  return (
    ((await tryDecrypt(bucket.bucketName)) ?? serverEnv().CAP_AWS_BUCKET) || ""
  );
}

export async function createS3Client(config?: S3Config) {
  const s3Config = await getS3Config(config);
  const isLocalOrMinio =
    s3Config.endpoint?.includes("localhost") ||
    s3Config.endpoint?.includes("127.0.0.1");

  return [
    new S3Client({
      ...s3Config,
      maxAttempts: isLocalOrMinio ? 5 : 3,
    }),
    s3Config,
  ] as const;
}
