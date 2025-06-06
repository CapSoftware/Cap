import {
  GetObjectCommand,
  HeadObjectCommand,
  HeadObjectOutput,
  ListObjectsV2Command,
  ListObjectsV2Output,
  S3Client,
} from "@aws-sdk/client-s3";
import type { s3Buckets } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";
import { decrypt } from "@cap/database/crypto";
import { buildEnv, serverEnv } from "@cap/env";
import * as S3Presigner from "@aws-sdk/s3-request-presigner";
import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";
import { S3_BUCKET_URL } from "@cap/utils";

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

interface S3BucketProvider {
  getSignedObjectUrl(key: string): Promise<string>;
  getObject(key: string): Promise<string | undefined>;
  listObjects(config?: {
    prefix?: string;
    maxKeys?: number;
  }): Promise<ListObjectsV2Output>;
  headObject(key: string): Promise<HeadObjectOutput>;
}

function createCloudFrontProvider(config: {
  s3: S3Client;
  bucket: string;
  keyPairId: string;
  privateKey: string;
}): S3BucketProvider {
  const s3 = createS3Provider(config.s3, config.bucket);
  return {
    ...s3,
    async getSignedObjectUrl(key: string) {
      const url = `${S3_BUCKET_URL}/${key}`;
      const expires = Math.floor((Date.now() + 3600 * 1000) / 1000);

      const policy = {
        Statement: [
          {
            Resource: url,
            Condition: {
              DateLessThan: { "AWS:EpochTime": Math.floor(expires) },
            },
          },
        ],
      };

      return CloudFrontPresigner.getSignedUrl({
        url,
        keyPairId: config.keyPairId,
        privateKey: config.privateKey,
        policy: JSON.stringify(policy),
      });
    },
  };
}

function createS3Provider(client: S3Client, bucket: string): S3BucketProvider {
  return {
    getSignedObjectUrl(key: string) {
      return S3Presigner.getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: 3600 }
      );
    },
    async getObject(key: string, format = "string") {
      const resp = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      if (format === "string") {
        return await resp.Body?.transformToString();
      }
    },
    async listObjects(config) {
      return await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: config?.prefix,
          MaxKeys: config?.maxKeys,
        })
      );
    },
    async headObject(key) {
      return await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
      );
    },
  };
}

export async function createBucketProvider(
  customBucket?: InferSelectModel<typeof s3Buckets> | null
) {
  const bucket = await getS3Bucket(customBucket);
  const [s3Client] = await createS3Client(customBucket);

  if (!customBucket && serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID) {
    const keyPairId = serverEnv().CLOUDFRONT_KEYPAIR_ID;
    const privateKey = serverEnv().CLOUDFRONT_KEYPAIR_PRIVATE_KEY;

    if (!keyPairId || !privateKey)
      throw new Error("Missing CloudFront keypair ID or private key");

    return createCloudFrontProvider({
      s3: s3Client,
      bucket,
      keyPairId,
      privateKey,
    });
  }

  return createS3Provider(s3Client, bucket);
}
