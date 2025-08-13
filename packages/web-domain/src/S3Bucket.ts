import { Schema } from "effect";

export const S3BucketId = Schema.String.pipe(Schema.brand("S3BucketId"));
export type S3BucketId = typeof S3BucketId.Type;

export class S3Bucket extends Schema.Class<S3Bucket>("S3Bucket")({
	id: Schema.String,
	ownerId: Schema.String,
	region: Schema.String,
	endpoint: Schema.OptionFromNullOr(Schema.String),
	name: Schema.String,
	accessKeyId: Schema.String,
	secretAccessKey: Schema.String,
}) {}

export const decodeSync = Schema.decodeSync(S3Bucket);
