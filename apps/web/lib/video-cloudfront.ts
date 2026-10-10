import { serverEnv } from "@cap/env";
import { S3Bucket } from "@cap/web-domain";

export function getVideoCloudFrontDistributionId(bucketId: string | null) {
	if (bucketId === S3Bucket.TokyoBucketId)
		return serverEnv().CAP_TOKYO_CLOUDFRONT_DISTRIBUTION_ID;
	if (bucketId) return undefined;
	return serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
}
