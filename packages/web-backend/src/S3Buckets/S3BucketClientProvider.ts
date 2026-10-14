import type { S3Client } from "@aws-sdk/client-s3";
import { type Cause, Context, type Effect } from "effect";

export class S3BucketClientProvider extends Context.Service<
	S3BucketClientProvider,
	{
		getInternal: Effect.Effect<S3Client, Cause.UnknownError>;
		getPublic: Effect.Effect<S3Client, Cause.UnknownError>;
		bucket: string;
		isPathStyle: boolean;
	}
>()("S3BucketClientProvider") {}
