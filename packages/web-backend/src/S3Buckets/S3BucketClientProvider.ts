import type { S3Client } from "@aws-sdk/client-s3";
import { type Cause, Context, type Effect } from "effect";

export class S3BucketClientProvider extends Context.Tag(
	"S3BucketClientProvider",
)<
	S3BucketClientProvider,
	{
		getInternal: Effect.Effect<S3Client, Cause.UnknownException>;
		getPublic: Effect.Effect<S3Client, Cause.UnknownException>;
		bucket: string;
		isPathStyle: boolean;
	}
>() {}
