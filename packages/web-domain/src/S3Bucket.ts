import { Schema } from "effect";
import { UserId } from "./User.ts";

export const S3BucketId = Schema.String.pipe(Schema.brand("S3BucketId"));
export type S3BucketId = typeof S3BucketId.Type;

// Reserved IDs fit videos.bucket and cannot collide with customer IDs (no hyphens).
export const RegionalBuckets = [
	{
		region: "us-west-2",
		id: S3BucketId.make("cap-oregon"),
		latitude: 45.84,
		longitude: -119.7,
	},
	{
		region: "eu-west-1",
		id: S3BucketId.make("cap-ireland"),
		latitude: 53.35,
		longitude: -6.26,
	},
	{
		region: "eu-central-1",
		id: S3BucketId.make("cap-frankfurt"),
		latitude: 50.11,
		longitude: 8.68,
	},
	{
		region: "sa-east-1",
		id: S3BucketId.make("cap-sao-paulo"),
		latitude: -23.55,
		longitude: -46.63,
	},
	{
		region: "af-south-1",
		id: S3BucketId.make("cap-cape-town"),
		latitude: -33.92,
		longitude: 18.42,
	},
	{
		region: "ap-south-1",
		id: S3BucketId.make("cap-mumbai"),
		latitude: 19.08,
		longitude: 72.88,
	},
	{
		region: "ap-southeast-1",
		id: S3BucketId.make("cap-singapore"),
		latitude: 1.35,
		longitude: 103.82,
	},
	{
		region: "ap-northeast-1",
		id: S3BucketId.make("cap-tokyo"),
		latitude: 35.68,
		longitude: 139.69,
	},
	{
		region: "ap-southeast-2",
		id: S3BucketId.make("cap-sydney"),
		latitude: -33.87,
		longitude: 151.21,
	},
] as const;

export const getRegionalBucket = (id: string | null | undefined) =>
	RegionalBuckets.find((bucket) => bucket.id === id);

export const isCapManagedBucket = (id: string | null | undefined) =>
	!id || getRegionalBucket(id) !== undefined;

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
