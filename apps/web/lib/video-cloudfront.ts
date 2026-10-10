import { serverEnv } from "@cap/env";
import { parseRegionalBuckets } from "@cap/web-backend/src/S3Buckets/RegionalBuckets";

export function getVideoCloudFrontDistributionId(bucketId: string | null) {
	if (!bucketId) return serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	return parseRegionalBuckets(serverEnv().CAP_REGIONAL_UPLOAD_BUCKETS).find(
		(bucket) => bucket.id === bucketId,
	)?.distributionId;
}
