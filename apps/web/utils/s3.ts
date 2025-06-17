import {
  GetObjectCommand,
  HeadObjectCommand,
  HeadObjectOutput,
  ListObjectsV2Command,
  ListObjectsV2Output,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { s3Buckets } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";
import { decrypt } from "@cap/database/crypto";
import { serverEnv } from "@cap/env";
import * as S3Presigner from "@aws-sdk/s3-request-presigner";
import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";
import { S3_BUCKET_URL } from "@cap/utils";
import { StreamingBlobPayloadInputTypes } from "@smithy/types";

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

export async function getS3Config(config?: S3Config, internal = false) {
  if (!config) {
    return {
      endpoint: internal
        ? serverEnv().S3_INTERNAL_ENDPOINT ?? serverEnv().CAP_AWS_ENDPOINT
        : serverEnv().S3_PUBLIC_ENDPOINT ?? serverEnv().CAP_AWS_ENDPOINT,
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

export async function createS3Client(config?: S3Config, internal = false) {
  const s3Config = await getS3Config(config, internal);
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
  name: string;
  getSignedObjectUrl(key: string): Promise<string>;
  getObject(key: string): Promise<string | undefined>;
  listObjects(config?: {
    prefix?: string;
    maxKeys?: number;
  }): Promise<ListObjectsV2Output>;
  headObject(key: string): Promise<HeadObjectOutput>;
  putObject(
    key: string,
    body: StreamingBlobPayloadInputTypes,
    fields?: { contentType?: string }
  ): Promise<void>;
}

function createCloudFrontProvider(config: {
  s3: (internal: boolean) => Promise<S3Client>;
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

function createS3Provider(
  getClient: (internal: boolean) => Promise<S3Client>,
  bucket: string
): S3BucketProvider {
  return {
    name: bucket,
    async getSignedObjectUrl(key: string) {
      return S3Presigner.getSignedUrl(
        await getClient(false),
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: 3600 }
      );
    },
    async getObject(key: string, format = "string") {
      const resp = await getClient(true).then((c) =>
        c.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      );
      if (format === "string") {
        return await resp.Body?.transformToString();
      }
    },
    async listObjects(config) {
      return await getClient(true).then((c) =>
        c.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: config?.prefix,
            MaxKeys: config?.maxKeys,
          })
        )
      );
    },
    headObject: (key) =>
      getClient(true).then((client) =>
        client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      ),
    putObject: (key, body, fields) =>
      getClient(true).then((client) =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: fields?.contentType,
          })
        )
      ),
  };
}

export async function createBucketProvider(
  customBucket?: InferSelectModel<typeof s3Buckets> | null
) {
  const bucket = await getS3Bucket(customBucket);
  const getClient = (internal: boolean) =>
    createS3Client(customBucket, internal).then((v) => v[0]);

  if (!customBucket && serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID) {
    const keyPairId = serverEnv().CLOUDFRONT_KEYPAIR_ID;
    const privateKey = serverEnv().CLOUDFRONT_KEYPAIR_PRIVATE_KEY;

    if (!keyPairId || !privateKey)
      throw new Error("Missing CloudFront keypair ID or private key");

    return createCloudFrontProvider({
      s3: getClient,
      bucket,
      keyPairId,
      privateKey,
    });
  }

  return createS3Provider(getClient, bucket);
}
