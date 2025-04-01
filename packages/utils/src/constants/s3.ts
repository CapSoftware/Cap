import { serverEnv } from "@cap/env";

export const S3_BUCKET_URL = (() => {
	const fixedUrl = serverEnv.CAP_AWS_BUCKET_URL;
	const endpoint = serverEnv.CAP_AWS_ENDPOINT;
	const bucket = serverEnv.CAP_AWS_BUCKET;
	const region = serverEnv.CAP_AWS_REGION;

	if (fixedUrl) return fixedUrl;
	if (endpoint) return `${endpoint}/${bucket}`;
	return `s3.${region}.amazonaws.com/${bucket}`;
})();
