import { S3Bucket } from "@cap/web-domain";
import { Option, Schema } from "effect";

const BucketConfig = Schema.Struct({
	bucket: Schema.String.pipe(
		Schema.pattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
	),
	bucketUrl: Schema.String.pipe(
		Schema.filter((value) => {
			try {
				const url = new URL(value);
				return url.protocol === "https:" && url.origin === value;
			} catch {
				return false;
			}
		}),
	),
	distributionId: Schema.NonEmptyTrimmedString,
});
const decodeConfig = Schema.decodeUnknownOption(
	Schema.parseJson(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
);

const decodeBucket = Schema.decodeUnknownOption(BucketConfig);

export function parseRegionalBuckets(value: string | undefined) {
	const config = Option.getOrUndefined(decodeConfig(value ?? ""));
	return S3Bucket.RegionalBuckets.flatMap((region) => {
		const bucket = Option.getOrUndefined(decodeBucket(config?.[region.region]));
		return bucket ? [{ ...region, ...bucket }] : [];
	});
}

export function getNearestRegionalBucket(
	latitude: string | undefined,
	longitude: string | undefined,
	buckets: ReadonlyArray<(typeof S3Bucket.RegionalBuckets)[number]>,
) {
	const lat = Number(latitude);
	const lon = Number(longitude);
	if (
		!latitude?.trim() ||
		!longitude?.trim() ||
		!Number.isFinite(lat) ||
		!Number.isFinite(lon) ||
		Math.abs(lat) > 90 ||
		Math.abs(lon) > 180
	)
		return Option.none<S3Bucket.S3BucketId>();

	const radians = Math.PI / 180;
	const distance = (targetLat: number, targetLon: number) =>
		Math.sin(((targetLat - lat) * radians) / 2) ** 2 +
		Math.cos(lat * radians) *
			Math.cos(targetLat * radians) *
			Math.sin(((targetLon - lon) * radians) / 2) ** 2;
	let nearest = Option.none<S3Bucket.S3BucketId>();
	let nearestDistance = distance(38.13, -78.45);
	for (const bucket of buckets) {
		const candidate = distance(bucket.latitude, bucket.longitude);
		if (candidate < nearestDistance) {
			nearest = Option.some(bucket.id);
			nearestDistance = candidate;
		}
	}
	return nearest;
}
