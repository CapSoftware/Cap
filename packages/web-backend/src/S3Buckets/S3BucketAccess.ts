import * as S3 from "@aws-sdk/client-s3";
import {
  RequestPresigningArguments,
  StreamingBlobPayloadInputTypes,
} from "@smithy/types";
import {
  createPresignedPost,
  PresignedPostOptions,
} from "@aws-sdk/s3-presigned-post";
import { Data, Effect, Option } from "effect";
import * as S3Presigner from "@aws-sdk/s3-request-presigner";
import { S3BucketClientProvider } from "./S3BucketClientProvider";

export class S3Error extends Data.TaggedError("S3Error")<{ message: string }> {}

const wrapS3Promise = <T>(
  callback: (provider: S3BucketClientProvider["Type"]) => Promise<T>
) =>
  Effect.flatMap(S3BucketClientProvider, (provider) =>
    Effect.tryPromise({
      try: () => callback(provider),
      catch: (e) => new S3Error({ message: String(e) }),
    })
  );

// @effect-diagnostics-next-line leakingRequirements:off
export class S3BucketAccess extends Effect.Service<S3BucketAccess>()(
  "S3BucketAccess",
  {
    sync: () => ({
      bucketName: Effect.map(S3BucketClientProvider, (p) => p.bucket),
      getSignedObjectUrl: (key: string) =>
        wrapS3Promise((provider) =>
          S3Presigner.getSignedUrl(
            provider.getPublic(),
            new S3.GetObjectCommand({ Bucket: provider.bucket, Key: key }),
            { expiresIn: 3600 }
          )
        ),
      getObject: (key: string) =>
        wrapS3Promise(async (provider) => {
          const a = await provider
            .getInternal()
            .send(
              new S3.GetObjectCommand({ Bucket: provider.bucket, Key: key })
            )
            .then((resp) => resp.Body?.transformToString())
            .catch((e) => {
              if (e instanceof S3.NoSuchKey) {
                return null;
              } else {
                throw e;
              }
            });

          return Option.fromNullable(a);
        }),
      listObjects: (config: { prefix?: string; maxKeys?: number }) =>
        wrapS3Promise((provider) =>
          provider.getInternal().send(
            new S3.ListObjectsV2Command({
              Bucket: provider.bucket,
              Prefix: config?.prefix,
              MaxKeys: config?.maxKeys,
            })
          )
        ),
      headObject: (key: string) =>
        wrapS3Promise((provider) =>
          provider
            .getInternal()
            .send(
              new S3.HeadObjectCommand({ Bucket: provider.bucket, Key: key })
            )
        ),
      putObject: (
        key: string,
        body: StreamingBlobPayloadInputTypes,
        fields?: { contentType?: string }
      ) =>
        wrapS3Promise((provider) =>
          provider.getInternal().send(
            new S3.PutObjectCommand({
              Bucket: provider.bucket,
              Key: key,
              Body: body,
              ContentType: fields?.contentType,
            })
          )
        ),
      /** Copy an object within the same bucket */
      copyObject: (
        source: string,
        key: string,
        args?: Omit<S3.CopyObjectCommandInput, "Bucket" | "CopySource" | "Key">
      ) =>
        wrapS3Promise((provider) =>
          provider.getInternal().send(
            new S3.CopyObjectCommand({
              Bucket: provider.bucket,
              CopySource: source,
              Key: key,
              ...args,
            })
          )
        ),
      deleteObject: (key: string) =>
        wrapS3Promise((provider) =>
          provider.getInternal().send(
            new S3.DeleteObjectCommand({
              Bucket: provider.bucket,
              Key: key,
            })
          )
        ),
      deleteObjects: (objects: S3.ObjectIdentifier[]) =>
        wrapS3Promise((provider) =>
          provider.getInternal().send(
            new S3.DeleteObjectsCommand({
              Bucket: provider.bucket,
              Delete: {
                Objects: objects,
              },
            })
          )
        ),
      getPresignedPutUrl: (
        key: string,
        args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
        signingArgs?: RequestPresigningArguments
      ) =>
        wrapS3Promise((provider) =>
          S3Presigner.getSignedUrl(
            provider.getPublic(),
            new S3.PutObjectCommand({
              Bucket: provider.bucket,
              Key: key,
              ...args,
            }),
            signingArgs
          )
        ),
      getPresignedPostUrl: (
        key: string,
        args: Omit<PresignedPostOptions, "Bucket" | "Key">
      ) =>
        wrapS3Promise((provider) =>
          createPresignedPost(provider.getPublic(), {
            ...args,
            Bucket: provider.bucket,
            Key: key,
          })
        ),
      multipart: {
        create: (
          key: string,
          args?: Omit<S3.CreateMultipartUploadCommandInput, "Bucket" | "Key">
        ) =>
          wrapS3Promise((provider) =>
            provider.getInternal().send(
              new S3.CreateMultipartUploadCommand({
                ...args,
                Bucket: provider.bucket,
                Key: key,
              })
            )
          ),
        getPresignedUploadPartUrl: (
          key: string,
          uploadId: string,
          partNumber: number,
          args?: Omit<
            S3.UploadPartCommandInput,
            "Key" | "Bucket" | "PartNumber" | "UploadId"
          >
        ) =>
          wrapS3Promise((provider) =>
            S3Presigner.getSignedUrl(
              provider.getPublic(),
              new S3.UploadPartCommand({
                ...args,
                Bucket: provider.bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
              })
            )
          ),
        complete: (
          key: string,
          uploadId: string,
          args?: Omit<
            S3.CompleteMultipartUploadCommandInput,
            "Key" | "Bucket" | "UploadId"
          >
        ) =>
          wrapS3Promise((provider) =>
            provider.getInternal().send(
              new S3.CompleteMultipartUploadCommand({
                Bucket: provider.bucket,
                Key: key,
                UploadId: uploadId,
                ...args,
              })
            )
          ),
      },
    }),
  }
) {}
