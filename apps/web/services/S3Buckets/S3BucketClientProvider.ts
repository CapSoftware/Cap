import { S3Client } from "@aws-sdk/client-s3";
import { Context } from "effect";

export class S3BucketClientProvider extends Context.Tag(
  "S3BucketClientProvider"
)<
  S3BucketClientProvider,
  { getInternal: () => S3Client; getPublic: () => S3Client; bucket: string }
>() {}
