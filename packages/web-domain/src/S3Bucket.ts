import { Schema } from "effect";
import { UserId } from "./User";

export const S3BucketId = Schema.String.pipe(Schema.brand("S3BucketId"));
export type S3BucketId = typeof S3BucketId.Type;

export class S3Bucket extends Schema.Class<S3Bucket>("S3Bucket")({
	id: S3BucketId,
	ownerId: UserId,
	region: Schema.String,
	endpoint: Schema.OptionFromNullOr(Schema.String),
	name: Schema.String,
	accessKeyId: Schema.String,
	secretAccessKey: Schema.String,
}) {}

export const Workflows = [S3Bucket] as const;

export const decodeSync = Schema.decodeSync(S3Bucket);
