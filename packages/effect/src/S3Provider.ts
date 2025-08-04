import {
  CompleteMultipartUploadCommand,
  CompleteMultipartUploadCommandInput,
  CompleteMultipartUploadOutput,
  CopyObjectCommand,
  CopyObjectCommandInput,
  CopyObjectCommandOutput,
  CreateMultipartUploadCommand,
  CreateMultipartUploadCommandInput,
  CreateMultipartUploadOutput,
  DeleteObjectCommand,
  DeleteObjectCommandOutput,
  DeleteObjectsCommand,
  DeleteObjectsCommandOutput,
  GetObjectCommand,
  HeadObjectCommand,
  HeadObjectOutput,
  ListObjectsV2Command,
  ListObjectsV2Output,
  ObjectIdentifier,
  PutObjectCommand,
  PutObjectCommandOutput,
  PutObjectRequest,
  S3Client,
  UploadPartCommand,
  UploadPartCommandInput,
} from "@aws-sdk/client-s3";
import { Context, Effect, Layer } from "effect";
import {
  RequestPresigningArguments,
  StreamingBlobPayloadInputTypes,
} from "@smithy/types";
import {
  createPresignedPost,
  PresignedPost,
  PresignedPostOptions,
} from "@aws-sdk/s3-presigned-post";
import * as S3Presigner from "@aws-sdk/s3-request-presigner";

export class S3Provider extends Context.Tag("S3Provider")<
  S3Provider,
  {
    bucket: string;
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
    ): Promise<PutObjectCommandOutput>;
    copyObject(
      source: string,
      key: string,
      args?: Omit<CopyObjectCommandInput, "Bucket" | "CopySource" | "Key">
    ): Promise<CopyObjectCommandOutput>;
    deleteObject(key: string): Promise<DeleteObjectCommandOutput>;
    deleteObjects(
      keys: ObjectIdentifier[]
    ): Promise<DeleteObjectsCommandOutput>;
    getPresignedPutUrl(
      key: string,
      args?: Omit<PutObjectRequest, "Key" | "Bucket">,
      signingArgs?: RequestPresigningArguments
    ): Promise<string>;
    getPresignedPostUrl(
      key: string,
      args: Omit<PresignedPostOptions, "Bucket" | "Key">
    ): Promise<PresignedPost>;
    multipart: {
      create(
        key: string,
        args?: Omit<CreateMultipartUploadCommandInput, "Bucket" | "Key">
      ): Promise<CreateMultipartUploadOutput>;
      getPresignedUploadPartUrl(
        key: string,
        uploadId: string,
        partNumber: number,
        args?: Omit<
          UploadPartCommandInput,
          "Key" | "Bucket" | "PartNumber" | "UploadId"
        >
      ): Promise<string>;
      complete(
        key: string,
        uploadId: string,
        args?: Omit<
          CompleteMultipartUploadCommandInput,
          "Key" | "Bucket" | "UploadId"
        >
      ): Promise<CompleteMultipartUploadOutput>;
    };
  }
>() {}

export const createS3Layer = (
  getClient: (internal: boolean) => Effect.Effect<S3Client>,
  bucket: string
) =>
  Layer.sync(S3Provider, () => ({
    bucket,
    async getSignedObjectUrl(key: string) {
      return S3Presigner.getSignedUrl(
        await Effect.runPromise(getClient(false)),
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: 3600 }
      );
    },
    async getObject(key: string, format = "string") {
      const resp = await Effect.runPromise(getClient(true)).then((c) =>
        c.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      );
      if (format === "string") {
        return await resp.Body?.transformToString();
      }
    },
    async listObjects(config) {
      return Effect.runPromise(await getClient(true)).then((c) =>
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
      Effect.runPromise(getClient(true)).then((client) =>
        client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      ),
    putObject: (key, body, fields) =>
      Effect.runPromise(getClient(true)).then((client) =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: fields?.contentType,
          })
        )
      ),
    copyObject: (source, key, args) =>
      Effect.runPromise(getClient(true)).then((client) =>
        client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: source,
            Key: key,
            ...args,
          })
        )
      ),
    deleteObject: (key) =>
      Effect.runPromise(getClient(true)).then((client) =>
        client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      ),
    deleteObjects: (objects: ObjectIdentifier[]) =>
      Effect.runPromise(getClient(true)).then((client) =>
        client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: objects,
            },
          })
        )
      ),
    getPresignedPutUrl: (key: string, args, signingArgs) =>
      Effect.runPromise(getClient(false)).then((client) =>
        S3Presigner.getSignedUrl(
          client,
          new PutObjectCommand({ Bucket: bucket, Key: key, ...args }),
          signingArgs
        )
      ),
    getPresignedPostUrl: (
      key: string,
      args: Omit<PresignedPostOptions, "Bucket" | "Key">
    ) =>
      Effect.runPromise(getClient(false)).then((client) =>
        createPresignedPost(client, {
          ...args,
          Bucket: bucket,
          Key: key,
        })
      ),
    multipart: {
      create: (key, args) =>
        Effect.runPromise(getClient(true)).then((client) =>
          client.send(
            new CreateMultipartUploadCommand({
              ...args,
              Bucket: bucket,
              Key: key,
            })
          )
        ),
      getPresignedUploadPartUrl: (key, uploadId, partNumber, args) => {
        console.log({
          ...args,
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        });
        return Effect.runPromise(getClient(false)).then((client) =>
          S3Presigner.getSignedUrl(
            client,
            new UploadPartCommand({
              ...args,
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
            })
          )
        );
      },
      complete: (key, uploadId, args) =>
        Effect.runPromise(getClient(true)).then((client) =>
          client.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              ...args,
            })
          )
        ),
    },
  }));
