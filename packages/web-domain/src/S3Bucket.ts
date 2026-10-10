import { Schema } from "effect";
import { UserId } from "./User.ts";

export const S3BucketId = Schema.String.pipe(Schema.brand("S3BucketId"));
export type S3BucketId = typeof S3BucketId.Type;

// This ID cannot collide with generated customer bucket IDs, which have no hyphens.
export const TokyoBucketId = S3BucketId.make("cap-tokyo");

export const isCapManagedBucket = (id: string | null | undefined) =>
	!id || id === TokyoBucketId;

export class S3Bucket extends Schema.Class<S3Bucket>("S3Bucket")({
	id: S3BucketId,
	ownerId: UserId,
	region: Schema.String,
	endpoint: Schema.OptionFromNullOr(Schema.String),
	name: Schema.String,
	accessKeyId: Schema.String,
	secretAccessKey: Schema.String,
}) {}

export const Workflows = [] as const;

export const decodeSync = Schema.decodeSync(S3Bucket);

export class S3Error extends Schema.TaggedError<S3Error>()("S3Error", {
	cause: Schema.Unknown,
}) {}
