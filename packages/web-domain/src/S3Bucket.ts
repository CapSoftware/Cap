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
		region: "ca-central-1",
		id: S3BucketId.make("cap-montreal"),
		latitude: 45.5,
		longitude: -73.57,
	},
	{
		region: "eu-west-2",
		id: S3BucketId.make("cap-london"),
		latitude: 51.51,
		longitude: -0.13,
	},
	{
		region: "eu-west-3",
		id: S3BucketId.make("cap-paris"),
		latitude: 48.86,
		longitude: 2.35,
	},
	{
		region: "eu-central-1",
		id: S3BucketId.make("cap-frankfurt"),
		latitude: 50.11,
		longitude: 8.68,
	},
	{
		region: "eu-north-1",
		id: S3BucketId.make("cap-stockholm"),
		latitude: 59.33,
		longitude: 18.07,
	},
	{
		region: "me-central-1",
		id: S3BucketId.make("cap-uae"),
		latitude: 24.45,
		longitude: 54.38,
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
		region: "ap-southeast-5",
		id: S3BucketId.make("cap-malaysia"),
		latitude: 3.14,
		longitude: 101.69,
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
