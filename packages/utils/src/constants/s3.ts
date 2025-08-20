import { buildEnv } from "@cap/env";

export const S3_BUCKET_URL = (() => {
	const fixedUrl = buildEnv.NEXT_PUBLIC_CAP_AWS_BUCKET_URL;
	const endpoint = buildEnv.NEXT_PUBLIC_CAP_AWS_ENDPOINT;
	const bucket = buildEnv.NEXT_PUBLIC_CAP_AWS_BUCKET;
	const region = buildEnv.NEXT_PUBLIC_CAP_AWS_REGION;

	if (fixedUrl) return fixedUrl;
	if (endpoint) return `${endpoint}/${bucket}`;
	return `s3.${region}.amazonaws.com/${bucket}`;
})();
